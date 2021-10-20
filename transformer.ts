import {
  ClassDeclaration,
  DeclarationStatement,
  Element,
  ElementKind,
  EnumDeclaration,
  FieldDeclaration,
  IntegerLiteralExpression,
  LiteralKind,
  Module,
  NamedTypeNode,
  NamespaceDeclaration,
  ThrowStatement,
  TypeDeclaration,
  TypeNode,
} from 'assemblyscript'
import { Transform } from 'assemblyscript/cli/transform'
import * as fs from 'fs'
import { snakeCase } from 'snake-case'
import { pascalCase } from 'pascal-case'
import debugFactory from 'debug'
import { fileURLToPath } from 'url'

const debug = debugFactory('graph:transformer')

export default class ToRustTransformer extends Transform {
  afterCompile(module: Module) {
    const typeAliases: ResolvedTypeAlias[] = []
    const declarations: ResolvedDeclaration[] = []

    this.program.parser.sources.forEach((x) => {
      x.statements.forEach((y) => {
        if (y instanceof NamespaceDeclaration) {
          // FIXME: Hard-coded `near` literal in there
          if (y.name.text === 'near') {
            y.members.forEach((z) => {
              if (z instanceof ClassDeclaration) {
                declarations.push(this.resolveClass(z))
              } else if (z instanceof TypeDeclaration) {
                debug('Walking type alias [%s] declarations', z.name.text)

                const aliasOf = this.resolveFieldType(y, z, z.type)
                if (aliasOf === undefined) {
                  throw new Error(`Unable to resolve type alias ${fieldName(y, z)}`)
                }

                typeAliases.push(new ResolvedTypeAlias(z.name.text, aliasOf))
              } else if (z instanceof EnumDeclaration) {
                declarations.push(this.resolveEnum(z))
              }
            })
          }
        }
      })
    })

    // FIXME: Hard-coded `near` literal in there
    const file = new File('./near.rs')

    const aliasesByName = Object.fromEntries(typeAliases.map((alias) => [`Asc${alias.name}`, alias.aliasOf]))

    const imports = this.computeImports(typeAliases, declarations)
    const arrayWrappers = this.computeArrayTypeWrappers(declarations)
    const enumWrappers = this.computeEnumTypeWrappers(declarations)

    try {
      this.generateImports(file, imports)

      typeAliases.forEach((typeAlias) => {
        this.generateTypeAlias(file, typeAlias)
      })
      file.writeLine('')

      arrayWrappers.forEach((arrayType) => {
        this.generateArrayWrapper(file, arrayType)
      })
      file.writeLine('')

      enumWrappers.forEach((enumType) => {
        this.generateEnumWrapper(file, enumType)
      })
      file.writeLine('')

      declarations.forEach((declaration) => {
        if (declaration instanceof ResolvedClass) {
          this.generateClass(file, declaration as ResolvedClass, aliasesByName)
        } else if (declaration instanceof ResolvedEnum) {
          this.generateEnum(file, declaration as ResolvedEnum)
        } else {
          throw new Error(
            `Unhandled resolved declaration's type ${declaration.constructor.name} for ${declaration.name}`,
          )
        }
        file.writeLine('')
      })
    } finally {
      file.close()
    }
  }

  computeImports(typeAliases: ResolvedTypeAlias[], declarations: ResolvedDeclaration[]): Imports {
    const imports = new Imports()

    // Some common module needed as soon as AssemblyScript derived is required
    imports.addModule('graph_runtime_derive', 'AscType')
    imports.addModule('graph::runtime', 'AscType')
    imports.addModule('graph::runtime', 'AscIndexId')
    imports.addModule('graph::runtime', 'DeterministicHostError')
    imports.addModule('graph::runtime', 'IndexForAscTypeId')
    imports.addModule('graph', 'semver')
    imports.addModule('graph', 'anyhow')
    imports.addModule('graph', 'semver::Version')
    imports.addModule('std::mem', 'size_of')

    typeAliases.forEach((typeAlias) => {
      typeAlias.aliasOf.addToImports(imports)
    })

    declarations.forEach((declaration) => {
      if (declaration instanceof ResolvedClass) {
        declaration.fields.forEach((field) => {
          field.type.addToImports(imports)
        })
      } else if (declaration instanceof ResolvedEnum) {
        imports.addModule('graph_runtime_wasm::asc_abi::class', 'AscEnum')
        imports.addModule('graph::runtime', 'AscValue')
      } else {
        throw new Error(`Unhandled resolved declaration's type ${declaration.constructor.name} for ${declaration.name}`)
      }
    })

    return imports
  }

  computeArrayTypeWrappers(declarations: ResolvedDeclaration[]): ArrayResolvedType[] {
    const elements: Record<string, ArrayResolvedType> = {}
    declarations.forEach((declaration) => {
      if (declaration instanceof ResolvedClass) {
        declaration.fields.forEach((field) => {
          if (field.type instanceof ArrayResolvedType && !field.type.inner.isBuiltIn) {
            elements[field.type.toRustWrappedType()] = field.type
          }
        })
      }
    })

    return Object.values(elements)
  }

  computeEnumTypeWrappers(declarations: ResolvedDeclaration[]): EnumResolvedType[] {
    const elements: Record<string, EnumResolvedType> = {}
    declarations.forEach((declaration) => {
      if (declaration instanceof ResolvedClass) {
        declaration.fields.forEach((field) => {
          if (field.type instanceof EnumResolvedType) {
            elements[field.type.toRustWrappedType()] = field.type
          }
        })
      }
    })

    return Object.values(elements)
  }

  generateImports(file: File, imports: Imports) {
    Object.entries(imports.byModule).forEach(([module, values]) => {
      if (values.size === 0) {
        return
      }

      if (values.size === 1) {
        file.writeLine(`use ${module}::${values.keys().next().value};`)
      } else {
        file.writeLine(`use ${module}::{${Array.from(values).join(', ')}};`)
      }
    })

    file.writeLine('')
  }

  generateTypeAlias(file: File, typeAlias: ResolvedTypeAlias) {
    file.writeLine(`pub(crate) type Asc${typeAlias.name} = ${typeAlias.aliasOf.toRustType()};`)
  }

  generateArrayWrapper(file: File, arrayType: ArrayResolvedType) {
    const aliasName = arrayType.toRustType()

    file.writeLine(`pub struct ${aliasName}(pub(crate) ${arrayType.toRustWrappedType()});`)
    file.writeLine('')

    file.writeLine(`impl AscType for ${aliasName} {`)
    file.writeLine(`    fn to_asc_bytes(&self) -> Result<Vec<u8>, DeterministicHostError> {`)
    file.writeLine(`        self.0.to_asc_bytes()`)
    file.writeLine('    }')
    file.writeLine('')
    file.writeLine(
      `    fn from_asc_bytes(asc_obj: &[u8], api_version: &Version) -> Result<Self, DeterministicHostError> {`,
    )
    file.writeLine(`        Ok(Self(Array::from_asc_bytes(asc_obj, api_version)?))`)
    file.writeLine('    }')
    file.writeLine('}')
    file.writeLine('')

    file.writeLine(`impl AscIndexId for ${aliasName} {`)
    // FIXME: Hard-coded `near` literal in there
    file.writeLine(
      `    const INDEX_ASC_TYPE_ID: IndexForAscTypeId = IndexForAscTypeId::NearArray${arrayType.inner.name};`,
    )
    file.writeLine('}')
    file.writeLine('')
  }

  generateEnumWrapper(file: File, enumType: EnumResolvedType) {
    const aliasName = enumType.toRustType()

    file.writeLine(`pub struct ${aliasName}(pub(crate) ${enumType.toRustWrappedType()});`)
    file.writeLine('')

    file.writeLine(`impl AscType for ${aliasName} {`)
    file.writeLine(`    fn to_asc_bytes(&self) -> Result<Vec<u8>, DeterministicHostError> {`)
    file.writeLine(`        self.0.to_asc_bytes()`)
    file.writeLine('    }')
    file.writeLine('')
    file.writeLine(
      `    fn from_asc_bytes(asc_obj: &[u8], api_version: &Version) -> Result<Self, DeterministicHostError> {`,
    )
    file.writeLine(`        Ok(Self(AscEnum::from_asc_bytes(asc_obj, api_version)?))`)
    file.writeLine('    }')
    file.writeLine('}')
    file.writeLine('')

    file.writeLine(`impl AscIndexId for ${aliasName} {`)
    // FIXME: Hard-coded `near` literal in there
    file.writeLine(`    const INDEX_ASC_TYPE_ID: IndexForAscTypeId = IndexForAscTypeId::Near${enumType.name}Enum;`)
    file.writeLine('}')
    file.writeLine('')
  }

  generateClass(file: File, clazz: ResolvedClass, aliases: Record<string, ResolvedType>) {
    file.writeLine('#[repr(C)]')
    file.writeLine('#[derive(AscType)]')
    file.writeLine(`pub(crate) struct Asc${clazz.name} {`)

    clazz.fields.forEach((field) => {
      let rustType = field.type.toRustType()
      if (field.type.isPointerType()) {
        const alias = aliases[rustType]
        if (alias == null || alias.isPointerType()) {
          rustType = `AscPtr<${rustType}>`
        }
      }

      file.writeLine(`    pub ${snakeCase(field.name)}: ${rustType},`)
    })

    file.writeLine('}')
    file.writeLine('')

    file.writeLine(`impl AscIndexId for Asc${clazz.name} {`)
    // FIXME: Hard-coded `near` literal in there
    file.writeLine(`    const INDEX_ASC_TYPE_ID: IndexForAscTypeId = IndexForAscTypeId::Near${clazz.name};`)
    file.writeLine('}')
    file.writeLine('')
  }

  generateEnum(file: File, resolvedEnum: ResolvedEnum) {
    file.writeLine('#[repr(u32)]')
    file.writeLine('#[derive(AscType, Copy, Clone)]')
    file.writeLine(`pub(crate) enum Asc${resolvedEnum.name} {`)

    // It seems graph-node does not accept defined enum value, so they are always checked to increase
    resolvedEnum.values.forEach((element) => {
      file.writeLine(`    ${pascalCase(element.name)},`)
    })

    file.writeLine('}')
    file.writeLine('')

    file.writeLine(`impl AscValue for Asc${resolvedEnum.name} {}`)
    file.writeLine('')

    file.writeLine(`impl Default for Asc${resolvedEnum.name} {`)
    file.writeLine('    fn default() -> Self {')
    file.writeLine(`        Self::${pascalCase(resolvedEnum.values[0].name)}`)
    file.writeLine('    }')
    file.writeLine('}')
    file.writeLine('')
  }

  resolveClass(node: ClassDeclaration): ResolvedClass {
    debug('Walking class [%s] declarations', node.name.text)

    const fields: ResolvedField[] = []
    node.members.forEach((fieldDecl) => {
      if (!(fieldDecl instanceof FieldDeclaration)) {
        // We do not care about anything else than FieldDeclaration for now
        return
      }

      const resolvedField = this.resolveField(node, fieldDecl)
      if (!resolvedField) {
        // A proper message has been logged to the user, no need to perform anything here
        return
      }

      debug(
        `Field %s => %s (builtin?: %s, enum?: %s)`,
        resolvedField.name,
        resolvedField.type.name,
        resolvedField.type.isBuiltIn,
        resolvedField.type.isEnum,
      )
      fields.push(resolvedField)
    })

    return new ResolvedClass(node.name.text, fields)
  }

  // resolves a type using AssemblyScript program, returns a trimmed down view of
  // of the resolved type containing its name, its source and it's a built-in type
  // from AssemblyScript directly.
  resolveField(from: DeclarationStatement, node: FieldDeclaration): ResolvedField | undefined {
    if (node.type == null) {
      console.warn(`Type of field ${fieldName(from, node)} is unknown`)
      return undefined
    }

    const resolveType = this.resolveFieldType(from, node, node.type)
    if (resolveType === undefined) {
      return undefined
    }

    return {
      name: node.name.text,
      type: resolveType,
    }
  }

  resolveFieldType(
    from: DeclarationStatement,
    node: DeclarationStatement,
    typeNode: TypeNode,
  ): ResolvedType | undefined {
    if (!(typeNode instanceof NamedTypeNode)) {
      throw new Error(
        `Type of field ${fieldName(
          from,
          node,
        )} is not a NamedTypeNode, please adjust the codebase to support if you care about this field`,
      )
    }

    const element = this.program.getElementByDeclaration(node)
    if (element == null) {
      throw new Error(`Unable to find element for field ${fieldName(from, node)}`)
    }

    const resolution = this.program.resolver.resolveTypeName(typeNode.name, element)
    if (!resolution) {
      throw new Error(`Unable to resolve type ${typeNode.name.identifier.text} for field ${fieldName(from, node)}`)
    }

    return this.toResolveType(from, node, typeNode, resolution)
  }

  resolveEnum(node: EnumDeclaration): ResolvedEnum {
    debug('Walking enum [%s] declarations', node.name.text)

    const values: ResolvedEnumValue[] = []

    let activeIndex = -1
    node.values.forEach((valueDecl, index) => {
      let inferred = true

      if (valueDecl.initializer == null) {
        activeIndex++
      } else {
        if (!valueDecl.initializer.isLiteralKind(LiteralKind.INTEGER)) {
          throw new Error(`Enum value ${fieldName(node, valueDecl)} needs to be of integer type`)
        }

        const numericLiteral = valueDecl.initializer as IntegerLiteralExpression
        if (!i64_is_u32(numericLiteral.value)) {
          throw new Error(`Enum value ${fieldName(node, valueDecl)} integer should be lower than 32 bits`)
        }

        activeIndex = i64_low(numericLiteral.value)
        inferred = false
      }

      if (activeIndex !== index) {
        throw new Error(`Enum value ${fieldName(node, valueDecl)} does not monotically increase starting at 0`)
      }

      const element = { name: valueDecl.name.text, value: activeIndex }
      debug(`Enum value %s => %s (inferred? %s)`, element.name, element.value, inferred)
      values.push(element)
    })

    return new ResolvedEnum(node.name.text, values)
  }

  toResolveType(
    from: DeclarationStatement,
    node: DeclarationStatement,
    typeNode: NamedTypeNode,
    resolution: Element,
  ): ResolvedType {
    const name = resolution.name
    const source = resolution.file.name

    if (source.startsWith('~lib/')) {
      if (resolution.name === 'Array') {
        const typeArgumentCount = typeNode.typeArguments?.length || 0
        if (typeArgumentCount != 1) {
          throw new Error(
            `Array resolved type should have exactly 1 type arguments, got ${typeArgumentCount} for field ${fieldName(
              from,
              node,
            )}`,
          )
        }

        const arrayTypeNode = typeNode.typeArguments![0]
        const arrayResolvedType = this.resolveFieldType(from, node, arrayTypeNode)
        if (arrayResolvedType === undefined) {
          throw new Error(`Unable to resolve array type for field ${fieldName(from, node)}`)
        }

        return new ArrayResolvedType(name, source, arrayResolvedType)
      }

      return new BuiltInResolvedType(name, source)
    }

    if (source.startsWith('build/lib/common')) {
      return new GraphCommonResolvedType(name, source)
    }

    if (resolution.kind === ElementKind.ENUM) {
      return new EnumResolvedType(name, source)
    }

    return new ObjectResolvedType(name, source)
  }
}

class Imports {
  byModule: Record<string, Set<string>> = {}

  addModule(module: string, name: string) {
    if (this.byModule[module] === undefined) {
      this.byModule[module] = new Set()
    }

    const elements = this.byModule[module]
    elements.add(name)
  }
}

class ResolvedDeclaration {
  constructor(public name: string) {}
}

class ResolvedTypeAlias extends ResolvedDeclaration {
  constructor(public name: string, public aliasOf: ResolvedType) {
    super(name)
  }
}

class ResolvedClass extends ResolvedDeclaration {
  constructor(public name: string, public fields: ResolvedField[]) {
    super(name)
  }
}

type ResolvedField = {
  name: string
  type: ResolvedType
}

type ResolvedEnumValue = {
  name: string
  value: number
}

class ResolvedEnum extends ResolvedDeclaration {
  constructor(public name: string, public values: ResolvedEnumValue[]) {
    super(name)
  }
}

abstract class ResolvedType {
  constructor(public name: string, public source: string) {}

  abstract addToImports(imports: Imports): void

  abstract isPointerType(): boolean

  abstract toRustType(): string

  get isEnum(): boolean {
    return this instanceof EnumResolvedType
  }

  get isBuiltIn(): boolean {
    return this instanceof BuiltInResolvedType
  }
}

class BuiltInResolvedType extends ResolvedType {
  addToImports(imports: Imports): void {
    if (this.name === 'string') {
      imports.addModule('graph::runtime', 'AscPtr')
      imports.addModule('graph_runtime_wasm::asc_abi::class', 'AscString')
    }
  }

  isPointerType(): boolean {
    if (this.name === 'string') {
      return true
    }

    return false
  }

  toRustType(): string {
    if (this.name === 'bool' || this.name === 'u64' || this.name === 'u32' || this.name === 'i64' || this.name === 'i32') {
      return this.name
    }

    if (this.name === 'string') {
      return 'AscString'
    }

    throw new Error(`Unknown BuiltIn ${this.name}, modify codebase`)
  }
}

class GraphCommonResolvedType extends ResolvedType {
  addToImports(imports: Imports): void {
    imports.addModule('graph::runtime', 'AscPtr')

    if (this.name === 'Bytes') {
      imports.addModule('graph_runtime_wasm::asc_abi::class', 'Uint8Array')
    } else if (this.name === 'BigInt') {
      imports.addModule('graph_runtime_wasm::asc_abi::class', 'AscBigInt')
    }
  }

  isPointerType(): boolean {
    return true
  }

  toRustType(): string {
    if (this.name === 'Bytes') {
      return 'Uint8Array'
    }

    if (this.name === 'BigInt') {
      return 'AscBigInt'
    }

    throw new Error(`Unknown The Graph common type ${this.name}`)
  }
}

class ArrayResolvedType extends ResolvedType {
  constructor(public name: string, public source: string, public inner: ResolvedType) {
    super(name, source)
  }

  addToImports(imports: Imports): void {
    imports.addModule('graph::runtime', 'AscPtr')
    imports.addModule('graph_runtime_wasm::asc_abi::class', 'Array')

    this.inner.addToImports(imports)
  }

  isPointerType(): boolean {
    return true
  }

  toRustWrappedType(): string {
    // Hopefully, we never end with an infinite series of type ...
    let rustType = this.inner.toRustType()
    if (this.inner.isPointerType()) {
      rustType = `AscPtr<${rustType}>`
    }

    return `Array<${rustType}>`
  }

  toRustType(): string {
    if (this.inner.isBuiltIn) {
      return this.toRustWrappedType()
    }

    // FIXME: This is not totally right, if the inner is itself an array, than the `name` would be
    //        Array and it's not what we want.
    return `Asc${this.inner.name}Array`
  }
}

class EnumResolvedType extends ResolvedType {
  addToImports(imports: Imports): void {
    imports.addModule('graph::runtime', 'AscPtr')
    imports.addModule('graph_runtime_wasm::asc_abi::class', 'AscEnum')
  }

  isPointerType(): boolean {
    return true
  }

  toRustWrappedType(): string {
    return `AscEnum<Asc${this.name}>`
  }

  toRustType(): string {
    return `Asc${this.name}Enum`
  }
}

class ObjectResolvedType extends ResolvedType {
  addToImports(imports: Imports): void {
    imports.addModule('graph::runtime', 'AscPtr')
  }

  isPointerType(): boolean {
    return true
  }

  toRustType(): string {
    return `Asc${this.name}`
  }
}

function fieldName(node: DeclarationStatement, fieldDecl: DeclarationStatement): string {
  return `${node.name.text}#${fieldDecl.name.text}`
}

class File {
  private fileHandle: number

  constructor(filePath: string) {
    this.fileHandle = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY)

    if (this.fileHandle <= 0) {
      throw new Error(`Unable to open ${filePath}`)
    }
  }

  writeLine(input: string) {
    fs.writeSync(this.fileHandle, input + '\n')
  }

  close() {
    fs.closeSync(this.fileHandle)
  }
}

// Required otherwise AssemblyScript is unable to load us because default emitted code looks like
// this:
//
// ```
//   ...
//   exports.default = ToRustTransformer
// ```
//
// And this leads to the need to do `require('./path/index.js').default` which of course the
// AssemblyScript binary knowns nothing about.
//
// To overcome, simply add this line here and it will be emitted in the final file and it will
// just works.
module.exports = ToRustTransformer
