/**
 * Snapshot of the SDK's public API: the names and signatures exported by each public entry, written to api.md, so
 * any public API change shows up in review. Types generated from openapi.json are only counted, not listed (their
 * changes show up in openapi.json).
 *
 * Usage (repo root): pnpm check:api (fails on mismatch); pnpm check:api --write (updates the snapshot)
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

const root = path.resolve(import.meta.dirname, "..")
const file = path.join(root, "api.md")

function entries() {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    name: string
    exports: Record<string, string>
  }
  return Object.entries(pkg.exports).map(([subpath, source]) => ({
    name: subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`,
    source: path.join(root, source),
  }))
}

const printer = ts.createPrinter({ removeComments: true, omitTrailingSemicolon: true })
const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType

/**
 * Prints a declaration as written in source (without comments or bodies) on one line; functions without a declared
 * return type get the inferred one
 */
function describe(checker: ts.TypeChecker, name: string, symbol: ts.Symbol): string[] {
  const declarations = symbol.declarations ?? []
  const print = (node: ts.Node) =>
    printer
      .printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
      .replace(/^export (declare )?/, "")
      .replace(/\s+/g, " ")
      .replace(/ ;/g, ";")
      .trim()
  // Parameters with defaults are printed as in type declarations: optional, typed, without the default value
  const parameters = (list: ts.NodeArray<ts.ParameterDeclaration>) =>
    list.map((item) =>
      item.initializer
        ? ts.factory.updateParameterDeclaration(
            item,
            item.modifiers,
            item.dotDotDotToken,
            item.name,
            ts.factory.createToken(ts.SyntaxKind.QuestionToken),
            item.type ??
              checker.typeToTypeNode(
                checker.getWidenedType(checker.getTypeAtLocation(item)),
                item,
                ts.NodeBuilderFlags.NoTruncation,
              ),
            undefined,
          )
        : item,
    )
  const lines = declarations.flatMap((node): string[] => {
    if (ts.isFunctionDeclaration(node)) {
      const signature = checker.getSignatureFromDeclaration(node)
      const type =
        node.type ??
        (signature &&
          checker.typeToTypeNode(checker.getReturnTypeOfSignature(signature), node, ts.NodeBuilderFlags.NoTruncation))
      return [
        print(
          ts.factory.updateFunctionDeclaration(
            node,
            undefined,
            node.asteriskToken,
            node.name,
            node.typeParameters,
            parameters(node.parameters),
            type,
            undefined,
          ),
        ),
      ]
    }
    if (ts.isClassDeclaration(node)) {
      const members = node.members
        .filter((member) => !member.modifiers?.some((item) => item.kind === ts.SyntaxKind.PrivateKeyword))
        .filter((member) => !(member.name && ts.isPrivateIdentifier(member.name)))
        .map((member) =>
          ts.isMethodDeclaration(member)
            ? ts.factory.updateMethodDeclaration(
                member,
                member.modifiers,
                member.asteriskToken,
                member.name,
                member.questionToken,
                member.typeParameters,
                parameters(member.parameters),
                member.type,
                undefined,
              )
            : ts.isConstructorDeclaration(member)
              ? ts.factory.updateConstructorDeclaration(
                  member,
                  member.modifiers,
                  parameters(member.parameters),
                  undefined,
                )
              : member,
        )
      return [
        print(
          ts.factory.updateClassDeclaration(
            node,
            undefined,
            node.name,
            node.typeParameters,
            node.heritageClauses,
            members,
          ),
        ),
      ]
    }
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return [print(node)]
    if (ts.isVariableDeclaration(node))
      return [
        `const ${name}: ${node.type ? print(node.type) : checker.typeToString(checker.getTypeAtLocation(node), undefined, flags)}`,
      ]
    if (ts.isModuleDeclaration(node)) return [`namespace ${name}`]
    return []
  })
  return lines.length > 0 ? lines : [name]
}

export function snapshot() {
  const list = entries()
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(root, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    },
  )!
  const program = ts.createProgram(
    list.map((entry) => entry.source),
    config.options,
  )
  const checker = program.getTypeChecker()
  const generated = (symbol: ts.Symbol) =>
    symbol.declarations?.some((item) => /[\\/]gen[\\/]/.test(item.getSourceFile().fileName)) ?? false

  const sections = list.map((entry) => {
    const module = checker.getSymbolAtLocation(program.getSourceFile(entry.source)!)!
    const exports = checker.getExportsOfModule(module).map((symbol) => ({
      name: symbol.name,
      symbol: symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
    }))
    const own = exports.filter((item) => !generated(item.symbol)).sort((a, b) => a.name.localeCompare(b.name))
    const count = exports.length - own.length
    return [
      `## ${entry.name}`,
      "",
      ...own.flatMap((item) => describe(checker, item.name, item.symbol)),
      ...(count ? [`+ ${count} exports generated from openapi.json`] : []),
    ].join("\n")
  })
  return [
    "# @merakcode/sdk public API",
    "",
    "Generated by `pnpm check:api --write`. Do not edit by hand.",
    "",
    ...sections,
    "",
  ]
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
}

if (import.meta.main) {
  const next = snapshot()
  if (process.argv.includes("--write")) {
    writeFileSync(file, next)
    console.log(`updated ${path.relative(process.cwd(), file)}`)
  } else {
    const current = (() => {
      try {
        return readFileSync(file, "utf8")
      } catch {
        return ""
      }
    })()
    if (current.replaceAll("\r\n", "\n") !== next) {
      console.error(
        "SDK public API changed: after reviewing, run pnpm check:api --write and commit packages/sdk/js/api.md with it",
      )
      process.exitCode = 1
    } else console.log("SDK public API unchanged")
  }
}
