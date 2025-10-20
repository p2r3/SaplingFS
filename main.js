const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const clipboard = require("clipboardy");

const { promisify } = require("node:util");
const zlib = require("node:zlib");
const unzip = promisify(zlib.unzip);
const deflate = promisify(zlib.deflate);

const world = require("./parseWorld.js");
const fileTools = require("./fileTools.js");
const worldGenTools = require("./worldGenTools.js");
const Vector = require("./Vector.js");

// Read command-line parameters
const worldName = process.argv[2];
const debug = process.argv.includes("--debug");
const rootPath = (process.argv.includes("--path") && process.argv?.[process.argv.indexOf("--path") + 1]) || "/";
const parentDepth = (process.argv.includes("--depth") && Number(process.argv?.[process.argv.indexOf("--depth") + 1])) || 3;

// Validate parameters
if (!worldName || !rootPath || !parentDepth) {
  console.error(`
Usage: SaplingFS <world> [options]

Options:
    --debug           Generates colorful terrain to help debug directory grouping
    --path <string>   Root path from which to look for files
    --depth <number>  Depth from absolute root at which to split directory groups`);
  process.exit();
}
// Find Minecraft world file path
let worldPath;
if (fs.existsSync(worldName) && fs.lstatSync(worldName).isDirectory()) {
  worldPath = worldName;
} else {
  worldPath = `${os.homedir()}/.minecraft/saves/${worldName}`;
}

const { mapping } = worldGenTools;

// Writes `mapping` data to disk, allowing for interrupted sessions
async function writeMappingToDisk () {

  const compactMapping = structuredClone(mapping);
  for (const key in compactMapping) {
    const { pos, file } = compactMapping[key];
    compactMapping[key].pos = [pos.x, pos.y, pos.z];
    compactMapping[key].file = [file.path, file.size, file.depth];
  }

  const json = JSON.stringify(compactMapping);
  const compressed = await deflate(json);
  await Bun.write(mappingJSONPath, compressed);

}

const mappingJSONPath = `${__dirname}/mapping/${worldName}.json.zlib`;
if (fs.existsSync(mappingJSONPath)) {

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
  const fileList = fileTools.buildFileList(rootPath);
  console.log(`Found ${fileList.length} files.\n`);

  console.log(`Generating terrain...`);
  await worldGenTools.buildRegionData(fileList, parentDepth, worldPath, debug);
  console.log(`Done, ${fileList.length} files left unallocated.\n`);

  await writeMappingToDisk();

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

  // Iterate over all used regions
  await world.forRegion(worldPath, async function (region, rx, rz) {

    // Compare checksums and skip region if no changes were made
    if (regionChecksum[`${rx},${rz}`] === region.checksum) return;
    regionChecksum[`${rx},${rz}`] = region.checksum;

    // Iterate over all mapped chunks within this region
    await worldGenTools.forMappedChunks(async function (blocks, entries, _x, _z, bounds) {

      // "Sleep" to allow other threads to run
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Check for changes in chunk hash and load data into block array
      const expectHash = chunkChecksum[`${_x},${_z}`];
      const returnHash = await world.regionToBlocks(region.bytes, blocks, rx, rz, bounds, expectHash);
      if (returnHash === null) return;
      chunkChecksum[`${_x},${_z}`] = returnHash;

      // Look for blocks that don't match the expected mapping
      for (const entry of entries) {

        const [x, y, z] = entry.pos.relative(_x, _z).toArray();
        const block = blocks[x][y][z];

        if (block === entry.block) continue;

        console.log(`Removed ${formatMappingString(entry)}`);
        console.log(` ^ Replaced by "${block}"`);

        const key = entry.pos.toString();
        delete mapping[key];

      }

    }, rx, rz);
  }, worldGenTools.terrainBounds);

  // Repeat this check after a delay
  setTimeout(checkBlockChanges, 200);
}
checkBlockChanges();

// Save block-file mapping every few minutes
setInterval(writeMappingToDisk, 1000 * 60 * 5);
