#!/usr/bin/env node
import ts from 'typescript'
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { readdir, readFile, writeFile } from 'node:fs/promises'

const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
        jsx: { type: 'boolean', default: false },
        prettier: { type: 'string', short: 'p' },
    },
})
if (positionals.length !== 1) {
    console.log(`Usage: ts-esm-migrate <folder>`)
    process.exit()
}

const workingFolder = join(process.cwd(), positionals[0])

const prettierConfig: object | undefined = values.prettier
    ? await readFile(join(process.cwd(), values.prettier), 'utf-8').then(JSON.parse)
    : undefined

console.log('Working on', workingFolder)

async function* walk(folder: string): AsyncGenerator<string> {
    for (const item of await readdir(folder, { withFileTypes: true })) {
        const { name } = item
        if (item.isFile()) {
            if (name.endsWith('.ts') || name.endsWith('.tsx')) yield join(folder, name)
        } else if (item.isDirectory()) {
            if (name !== 'node_modules') yield* walk(join(folder, name))
        }
    }
}

const visited = new Set<string>()
for await (const p of walk(workingFolder)) visited.add(p)

let currentVisitingFile: string
let hasUpdate: boolean
const transform: ts.TransformerFactory<ts.SourceFile> = function (context) {
    const { factory } = context
    function visit(node: ts.Node): ts.Node {
        if (ts.isSourceFile(node)) return ts.visitEachChild(node, visit, context)
        if (ts.isImportDeclaration(node)) {
            return factory.updateImportDeclaration(
                node,
                node.modifiers,
                node.importClause,
                updateImportPath(node.moduleSpecifier, factory),
                node.assertClause
            )
        }
        if (ts.isExportDeclaration(node)) {
            return factory.updateExportDeclaration(
                node,
                node.modifiers,
                node.isTypeOnly,
                node.exportClause,
                updateImportPath(node.moduleSpecifier, factory),
                node.assertClause
            )
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
            return factory.updateCallExpression(node, node.expression, node.typeArguments, [
                updateImportPath(node.arguments[0], factory),
                ...node.arguments.slice(1),
            ])
        }
        if (
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument) &&
            ts.isStringLiteral(node.argument.literal)
        ) {
            return factory.updateImportTypeNode(
                node,
                factory.updateLiteralTypeNode(node.argument, updateImportPath(node.argument.literal, factory)),
                node.assertions,
                node.qualifier,
                node.typeArguments,
                node.isTypeOf
            )
        }
        return ts.visitEachChild(node, visit, context)
    }
    return (sf) => visit(sf) as ts.SourceFile
}
const printer = ts.createPrinter()
await Promise.allSettled(
    [...visited].map(async (path) => {
        const file = await readFile(path, 'utf-8')
        const source = ts.createSourceFile(
            path,
            file.replace(/\n\n/g, '\n/** THIS_IS_A_NEWLINE **/'),
            ts.ScriptTarget.ESNext,
            false,
            path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        )
        hasUpdate = false
        currentVisitingFile = path
        const result = ts.transform(source, [transform])
        if (!hasUpdate) return
        const printed = printer.printFile(result.transformed[0]).replace(/\/\*\* THIS_IS_A_NEWLINE \*\*\//g, '\n')
        if (prettierConfig) {
            const prettier = await import('prettier')
            await writeFile(path, prettier.format(printed, { ...prettierConfig, parser: 'typescript' }))
        } else {
            await writeFile(path, printed)
        }
    })
)

function updateImportPath(node: ts.StringLiteral, factory: ts.NodeFactory): ts.StringLiteral
function updateImportPath(node: ts.Expression, factory: ts.NodeFactory): ts.Expression
function updateImportPath(node: ts.Expression | undefined, factory: ts.NodeFactory): ts.Expression | undefined
function updateImportPath(node: ts.Expression | undefined, factory: ts.NodeFactory): ts.Expression | undefined {
    if (!node) return node
    if (!ts.isStringLiteral(node)) return node
    const spec = node.text
    if (!spec.startsWith('.')) return node
    if (spec.endsWith('.js')) return node

    const resolution = join(currentVisitingFile, '../', spec)
    if (visited.has(resolution + '.ts') || visited.has(resolution + '.d.ts')) {
        hasUpdate = true
        return factory.createStringLiteral(spec + '.js')
    } else if (visited.has(resolution + '.tsx')) {
        hasUpdate = true
        return factory.createStringLiteral(spec + (values.jsx ? '.jsx' : '.js'))
    } else if (visited.has(join(resolution, 'index.ts')) || visited.has(join(resolution, 'index.d.ts'))) {
        hasUpdate = true
        return factory.createStringLiteral(spec + '/index.js')
    } else if (visited.has(join(resolution, 'index.tsx'))) {
        hasUpdate = true
        return factory.createStringLiteral(spec + (values.jsx ? '/index.jsx' : '/index.js'))
    }
    return node
}
