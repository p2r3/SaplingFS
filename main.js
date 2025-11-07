const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const clipboard = require("clipboardy");
const { $ } = require("bun");

const { promisify } = require("node:util");
const zlib = require("node:zlib");
const unzip = promisify(zlib.unzip);

const world = require("./parseWorld.js");
const fileTools = require("./fileTools.js");
const procTools = require("./procTools.js");
const worldGenTools = require("./worldGenTools.js");
const Vector = require("./Vector.js");

/**
 * Queries for an optional command-line argument or flag.
 *
 * @param {string} name - Name of argument (without "--")
 * @param {boolean} [isFlag=true] - Just a flag (no proceeding value)
 * @returns {boolean|string} Presence of flag or value of argument
 */
function queryArgument (name, isFlag = true) {
  const index = process.argv.indexOf("--" + name);
  if (index === -1) return false;
  if (isFlag) return true;
  return process.argv[index + 1];
}

// Platform-specific file tree defaults
const defaultRoot = process.platform === "win32" ? "C:\\" : "/";
const defaultParentDepth = process.platform === "win32" ? 2 : 3;

// Read command-line parameters
let worldName = process.argv[2];
const debug = queryArgument("debug");
const rootPath = queryArgument("path", false) || defaultRoot;
const parentDepth = Number(queryArgument("depth", false)) || defaultParentDepth;
const noProgress = queryArgument("no-progress");
const blacklist = queryArgument("blacklist") ? queryArgument("blacklist", false).split(";") : [];
const timeString = (new Date()).toLocaleTimeString("en-US", { hour12: false }).slice(0, -3);
const allowDelete = queryArgument("allow-delete", false) === timeString;
// Validate parameters
if (!worldName || !rootPath || !parentDepth) {
  console.error(
`Usage: SaplingFS <world> [options]

Options:
    --debug                 Generates colorful terrain to help debug directory grouping.
    --path <string>         Root path from which to look for files.
    --depth <number>        Depth from absolute root at which to split directory groups.
    --no-progress           Don't save/load current world progress to/from disk.
    --blacklist <path;...>  Semicolon-separted paths to blacklist from the scan.

    --allow-delete <hh:mm>  Enables actually deleting files when blocks are altered.
                            For confirmation, requires current system time in 24h format.
                            WARNING: THIS WILL IRREVERSIBLY DELETE FILES ON YOUR SYSTEM.`);
  process.exit();
}
// Find Minecraft world file path
let worldPath;
if (fs.existsSync(worldName) && fs.lstatSync(worldName).isDirectory()) {
  worldPath = path.normalize(worldName);
  worldName = worldPath.split(path.sep).pop();
} else {
  if (process.platform === "win32") {
    worldPath = path.join(os.homedir(), `AppData\\Roaming\\.minecraft\\saves\\${worldName}`);
  } else {
    worldPath = path.join(os.homedir(), `.minecraft/saves/${worldName}`);
  }
}

// Back up world data
const backupWorldPath = path.resolve(worldPath) + "_SaplingFS_backup";
if (!fs.existsSync(worldPath)) {
  console.error(`World not found: "${worldPath}"`);
  process.exit();
} else if (!fs.existsSync(backupWorldPath)) {
  console.log(`Creating backup of world "${worldName}"...\n`);
  fs.cpSync(worldPath, backupWorldPath, { recursive: true });
}

// Warn user *very explicitly* of the dangers of --allow-delete
if (allowDelete) {
  await new Promise(function (resolve) {

    console.error("WARNING: --allow-delete is enabled.");
    console.error("Real files on your computer are at risk.\n");
    console.log("You have 10 seconds to press Ctrl+C and stop the program:");

    let allowDeleteCountdown = 10;
    let allowDeleteInterval = setInterval(function () {
      console.log(`${allowDeleteCountdown}...`);
      allowDeleteCountdown --;
      if (allowDeleteCountdown === 0) {
        clearInterval(allowDeleteInterval);
        resolve();
      }
    }, 1000);

  });
}

const { mapping } = worldGenTools;

const cwd = process.cwd();
try { fs.mkdirSync(`${cwd}/mapping`) } catch { }
const mappingJSONPath = `${cwd}/mapping/${worldName}.json.zlib`;

if (!noProgress && fs.existsSync(mappingJSONPath)) {

  console.log("Restoring block-file mapping from file...");
  const compressed = await Bun.file(mappingJSONPath).bytes();
  const json = JSON.parse(await unzip(compressed));

  const [mins, maxs] = worldGenTools.terrainBounds;

  for (const key in json) {
    const pos = new Vector(...json[key].pos);
    mapping[key] = {
      block: json[key].block,
      file: new fileTools.MappedFile(...json[key].file),
      pos
    };
    if (pos.x < mins.x) mins.x = pos.x;
    else if (pos.x > maxs.x) maxs.x = pos.x;
    if (pos.y < mins.y) mins.y = pos.y;
    else if (pos.y > maxs.y) maxs.y = pos.y;
    if (pos.z < mins.z) mins.z = pos.z;
    else if (pos.z > maxs.z) maxs.z = pos.z;
  }

  console.log(`Done, loaded ${Object.keys(mapping).length} blocks.`);

} else {

  console.log(`Searching for files within "${rootPath}"...`);
  const fileList = fileTools.buildFileList(path.resolve(rootPath), blacklist);
  console.log(`Found ${fileList.length} files.\n`);

  console.log(`Generating terrain...`);
  await worldGenTools.buildRegionData(fileList, parentDepth, worldPath, mappingJSONPath, debug, noProgress);
  console.log(`Done, ${fileList.length} files left unallocated.\n`);

  if (!noProgress) {
    await writeMappingToDisk(mappingJSONPath);
  }

}

/**
 * Uses an implementation of 3D DDA to cast a ray that hits
 * the first mapped block.
 *
 * @param {Vector} pos - Starting position of the ray
 * @param {Vector} fvec - Ray direction (must be normalized)
 * @param {number} [range=50] – Maximum distance to search
 *
 * @returns {Object|null} – `mapping` entry or null if nothing was hit
 */
function raycast (pos, fvec, range = 50) {

  // Set the starting voxel
  let voxelX = Math.floor(pos.x);
  let voxelY = Math.floor(pos.y);
  let voxelZ = Math.floor(pos.z);

  // Calculate step direction for each axis
  const stepX = fvec.x > 0 ?  1 : fvec.x < 0 ? -1 : 0;
  const stepY = fvec.y > 0 ?  1 : fvec.y < 0 ? -1 : 0;
  const stepZ = fvec.z > 0 ?  1 : fvec.z < 0 ? -1 : 0;

  // Distance along the ray to cross one voxel in each axis
  const tDeltaX = fvec.x !== 0 ? Math.abs(1 / fvec.x) : Infinity;
  const tDeltaY = fvec.y !== 0 ? Math.abs(1 / fvec.y) : Infinity;
  const tDeltaZ = fvec.z !== 0 ? Math.abs(1 / fvec.z) : Infinity;

  // Distance from ray start to first voxel boundary on each axis
  const nextBoundaryX = stepX > 0 ? voxelX + 1 : voxelX;
  const nextBoundaryY = stepY > 0 ? voxelY + 1 : voxelY;
  const nextBoundaryZ = stepZ > 0 ? voxelZ + 1 : voxelZ;
  let tMaxX = fvec.x !== 0 ? (nextBoundaryX - pos.x) / fvec.x : Infinity;
  let tMaxY = fvec.y !== 0 ? (nextBoundaryY - pos.y) / fvec.y : Infinity;
  let tMaxZ = fvec.z !== 0 ? (nextBoundaryZ - pos.z) / fvec.z : Infinity;

  // Iterate until we hit a block or exceed range
  let distance = 0;
  while (distance <= range) {

    // Check for intersection with a mapped block
    const key = `${voxelX},${voxelY},${voxelZ}`;
    if (key in mapping) return mapping[key];

    // Choose the smallest tMax to step to the next voxel
    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) {
        voxelX += stepX;
        distance = tMaxX;
        tMaxX += tDeltaX;
      } else {
        voxelZ += stepZ;
        distance = tMaxZ;
        tMaxZ += tDeltaZ;
      }
    } else {
      if (tMaxY < tMaxZ) {
        voxelY += stepY;
        distance = tMaxY;
        tMaxY += tDeltaY;
      } else {
        voxelZ += stepZ;
        distance = tMaxZ;
        tMaxZ += tDeltaZ;
      }
    }

  }

  return null;
}

// Returns a human-readable representation of a block-file mapping
function formatMappingString (entry) {
  const positionString = entry.pos.toArray().join(" ");
  const shortPath = entry.file.getShortPath(parentDepth);
  return `"${entry.block}" at (${positionString}): "${shortPath}"`
}

console.log("Listening for clipboard changes...");

let clipboardLast = "";
setInterval(async function () {

  const text = await clipboard.default.read();
  if (text === clipboardLast) return;
  clipboardLast = text;

  if (!text.startsWith("/execute in minecraft:overworld run tp @s")) return;

  const [x, y, z, yaw, pitch] = text.split("@s ")[1].split(" ").map(c => Number(c));

  const pos = new Vector(x, y + 1.62, z); // Eye position
  const fvec = Vector.fromAngles(yaw, pitch); // Eye forward vector

  const entry = raycast(pos, fvec);

  if (!entry) {
    console.log("No file associated with this block.");
  } else {
    console.log(formatMappingString(entry));
  }

}, 200);

// Initialize region file cache from disk
await world.fillRegionFileCache(worldPath);

const regionChecksum = {};
const chunkChecksum = {};

console.log("Listening for block changes...");

async function checkBlockChanges () {

  // Iterate over all used regions asynchronously
  const regionPromises = [];
  regionPromises.push(world.forRegion(worldPath, async function (region, rx, rz) {

    // Compare checksums and skip region if no changes were made
    if (regionChecksum[`${rx},${rz}`] === region.checksum) return;
    regionChecksum[`${rx},${rz}`] = region.checksum;

    // Iterate over all mapped chunks within this region asynchronously
    const chunkPromises = [];
    chunkPromises.push(worldGenTools.forMappedChunks(async function (blocks, entries, _x, _z, bounds) {

      // "Sleep" to allow other threads to run
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Check for changes in chunk hash and load data into block array
      const expectHash = chunkChecksum[`${_x},${_z}`];
      const returnHash = await world.regionToBlocks(region.bytes, blocks, rx, rz, bounds, expectHash);
      if (returnHash === null) return;
      chunkChecksum[`${_x},${_z}`] = returnHash;

      // Look for blocks that don't match the expected mapping
      const blockPromises = [];
      for (const entry of entries) {
        blockPromises.push(new Promise(async function (resolve) {

          const [x, y, z] = entry.pos.relative(_x, _z).toArray();
          const block = blocks[x][y][z];

          if (block === entry.block) return resolve();

          console.log(`Removed ${formatMappingString(entry)}`);
          console.log(` ^ Replaced by "${block}"`);

          // If permitted, delete the associated file
          if (allowDelete) {
            const fullPath = entry.file.path;
            try {
              // First, kill any processes holding a handle to this file
              const pids = await procTools.getHandleOwners(fullPath);
              const promises = [];
              for (const pid of pids) {
                promises.push(procTools.killProcess(pid));
                console.log(`Killing process ${pid}`);
              }
              await Promise.all(promises);
              // Then, delete the file
              try {
                await $`rm -f "${fullPath}"`.quiet();
              } catch (e) {
                console.error(`Failed to delete file at "${fullPath}":\n`, e);
              }
            } catch (e) {
              console.error(`Failed to release handles of "${fullPath}":\n`, e);
            }
          }

          const key = entry.pos.toString();
          delete mapping[key];

          resolve();
        }));
      }
      // Join all block threads
      await Promise.all(blockPromises);

    }, rx, rz));
    // Join all chunk threads
    await Promise.all(chunkPromises);

  }, worldGenTools.terrainBounds));
  // Join all region threads
  await Promise.all(regionPromises);

  // Repeat this check after a delay
  setTimeout(checkBlockChanges, 200);
}
checkBlockChanges();

if (!noProgress) {
  // Save block-file mapping every few minutes
  setInterval(function () { writeMappingToDisk(mappingJSONPath) }, 1000 * 60 * 5);
}
