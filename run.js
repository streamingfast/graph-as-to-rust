const fs = require('fs')
const path = require('path')
const asc = require('assemblyscript/cli/asc')
const debugFactory = require('debug')
const rimraf = require('rimraf')

const debug = debugFactory('graph:as-to-rust')

function main() {
  debug('Preparing data foler for compilation')
  const buildDir = path.join(__dirname, 'build')
  const libDir = path.join(buildDir, 'lib')
  const libCommonDir = path.join(libDir, 'common')
  const libChainDir = path.join(libDir, 'chain')

  if (fs.existsSync(buildDir)) {
    rimraf.sync(buildDir)
  }

  fs.mkdirSync(buildDir)
  fs.mkdirSync(libDir)
  fs.mkdirSync(libCommonDir)
  fs.mkdirSync(libChainDir)

  debug('Copying graph-ts files over')
  copyGraphTsFile('common/datasource.ts', path.join(libCommonDir, 'datasource.ts'))
  copyGraphTsFile('common/eager_offset.ts', path.join(libCommonDir, 'eager_offset.ts'))
  copyGraphTsFile('common/json.ts', path.join(libCommonDir, 'json.ts'))
  copyGraphTsFile('common/numbers.ts', path.join(libCommonDir, 'numbers.ts'))
  copyGraphTsFile('common/collections.ts', path.join(libCommonDir, 'collections.ts'))
  copyGraphTsFile('common/conversion.ts', path.join(libCommonDir, 'conversion.ts'))
  copyGraphTsFile('common/value.ts', path.join(libCommonDir, 'value.ts'))

  copyGraphTsFile('chain/ethereum.ts', path.join(libChainDir, 'ethereum.ts'))
  copyGraphTsFile('chain/near.ts', path.join(libChainDir, 'near.ts'))

  copyGraphTsFile('index.ts', path.join(libDir, 'index.ts'))

  try {
    console.log('Compiling AssemblyScript and generating Rust code...')
    const sourceFile = path.join(__dirname, 'assembly_script', 'near.ts')
    const destinationFile = path.join(buildDir, 'near.wasm')
    const transformer = path.join(__dirname, 'dist', 'transformer.js')

    if (
      asc.main([
        '--explicitStart',
        '--exportRuntime',
        '--transform',
        transformer,
        '--runtime',
        'stub',
        sourceFile,
        '--lib',
        'test',
        '-b',
        destinationFile,
      ]) != 0
    ) {
      throw Error('Failed to compile')
    }

    console.log('Completed')
  } catch (e) {
    console.error(e)
    process.exitCode = 1
    throw e
  }
}

function copyGraphTsFile(from, to) {
  debug('Copying file %s to %s', from, to)
  fs.copyFileSync(`../graph-ts/${from}`, to)
}

main()
