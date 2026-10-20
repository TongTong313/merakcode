/**
 * Command name and npm package names. Lives in bin/ because the npm launcher requires it at startup.
 */

const commandName = "merak"

/** npm package id: the main package and the platform package prefix */
const packageName = "merakcode"

function binMap() {
  return { [commandName]: `./bin/${commandName}` }
}

/** Platform package: merakcode-<os>-<arch>. Windows is spelled "windows"; npm reserves "win32" for its os field. */
function platformPackage(platform, arch) {
  return `${packageName}-${platform === "win32" ? "windows" : platform}-${arch}`
}

module.exports = {
  commandName,
  packageName,
  binMap,
  platformPackage,
}
