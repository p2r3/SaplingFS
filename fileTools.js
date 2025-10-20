const fs = require("node:fs");
const path = require("node:path");

class MappedFile {

  constructor (path, size, depth) {
    this.path = path;
    this.size = size;
    this.depth = depth;
  }

  getShortParent (parentDepth) {
    const pathParts = this.path.split(path.sep).slice(0, -1);
    return pathParts.slice(0, parentDepth + 1).join(path.sep);
  }

  getShortPath (parentDepth) {
    const pathParts = this.path.split(path.sep);
    const pathFile = pathParts.pop();
    const pathStart = pathParts.slice(0, parentDepth + 1).join(path.sep);
    const pathEllipses = pathParts.length > (parentDepth + 2) ? "/..." : "";
    return `${pathStart}${pathEllipses}${path.sep}${pathFile}`;
  }

}

/**
 * Builds an array of files via depth-first search, starting with an input path.
 *
 * For each file, the output list contains an entry with its path, size in
 * bytes, and depth from the starting directory.
 *
 * @param {string} startPath - Directory from which to begin recursing
 * @param {array} [list=[]] - List to append to in each iteration
 * @param {number} [depth=0] - Starting depth, tracked internally
 *
 * @return {MappedFile[]} List of found files
 */
function buildFileList (startPath, list = [], depth = 0) {
  try {

    const items = fs.readdirSync(startPath, { withFileTypes: true });

    for (const item of items) {
      const itemPath = path.join(startPath, item.name);
      if (!item.isDirectory()) continue;
      if (item.name.includes("cache")) continue;
      buildFileList(itemPath, list, depth + 1);
    }

    for (const item of items) {
      const itemPath = path.join(startPath, item.name);
      if (!item.isFile()) continue;
      const size = fs.statSync(itemPath).size;
      if (size === 0) continue;

      list.push(new MappedFile(itemPath, size, depth));
    }

  } catch (error) {
    console.warn("Failed to read directory:", startPath);
  }
  return list;
}

module.exports = {
  MappedFile,
  buildFileList
};
