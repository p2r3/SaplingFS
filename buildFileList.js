const fs = require("node:fs");
const path = require("node:path");

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
 * @return {array} List of found files
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

      list.push({
        path: itemPath,
        size: size,
        depth: depth
      });
    }

  } catch (error) {
    console.warn("Failed to read directory:", startPath);
  }
  return list;
}

module.exports = buildFileList;
