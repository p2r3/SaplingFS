const path = require("node:path");

const Vector = require("./Vector.js");
const world = require("./parseWorld.js");

/**
 * List of blocks mapped to files in the following format:
 * mapping[`${x},${y},${z}`] = {
 *  pos: Vector,
 *  file: string,
 *  block: string
 * };
 */
const mapping = {};

// Absolute world boundaries (min/max vectors)
// Blocks will not generate past this
const WORLD_BOUNDS = [
  new Vector(-16 * 20, -64, -16 * 20),
  new Vector(16 * 20, 320, 16 * 20)
];
// Dynamic terrain boundaries, updated when generating terrain
let terrainBounds = [
  new Vector(0, 0, 0),
  new Vector(0, 0, 0)
];

// Whether the block is part of natural ground terrain
function isGroundBlock (block) {
  return (
    block === "dirt" ||
    block === "grass_block" ||
    block === "stone"
  );
}

// Whether grass converts to dirt under this block
function isHeavyBlock (block) {
  return (
    isGroundBlock(block) ||
    block === "oak_log" ||
    block === "water"
  );
}

// Whether the block is air (or unallocated)
function isAir (block) {
  return !block || block === "air";
}

// List of colorful blocks used for debugging directory groups
const debugPalette = [ "red_wool", "orange_wool", "yellow_wool", "lime_wool", "cyan_wool", "light_blue_wool", "magenta_wool", "pink_wool" ];

/**
 * Iterates over all 62 blocks that make up a tree, running a callback
 * function for each one. This callback is provided an absolute position,
 * and the respective block name as a string.
 *
 * @param {Vector} pos - Tree base position (absolute)
 * @param {function} callback - Function to call for each block
 */
function forTreeBlocks (pos, callback) {
  // Tree stump
  for (let i = 0; i < 5; i ++) {
    callback(pos.add(0, i, 0), "oak_log");
  }
  // Bottom leaf layer
  for (let i = 0; i < 2; i ++) {
    for (let j = -2; j <= 2; j ++) {
      for (let k = -2; k <= 2; k ++) {
        if (j === 0 && k === 0) continue;
        if (i === 1 && Math.abs(j) === 2 && Math.abs(k) === 2) continue;
        callback(pos.add(j, i + 2, k), "oak_leaves");
      }
    }
  }
  // Top leaf layer
  for (let i = 0; i < 2; i ++) {
    for (let j = -1; j <= 1; j ++) {
      for (let k = -1; k <= 1; k ++) {
        if (i === 0 && j === 0 && k === 0) continue;
        if (i === 1 && j !== 0 && k !== 0) continue;
        callback(pos.add(j, i + 4, k), "oak_leaves");
      }
    }
  }
}

/**
 * Iterates over chunks with blocks present in `mapping`, running a
 * callback function on each chunk.
 *
 * The callback is provided a block string array filled with air,
 * an array of relevant `mapping` entries, X/Z chunk coordinates,
 * and an array of min/max bounds for the chunk.
 *
 * @param {function }callback - The function to call (and await) on each chunk
 * @param {number|null} [rx=null] - Restrict to region (disabled by default)
 * @param {number|null} [rz=null] - Restrict to region (disabled by default)
 */
async function forMappedChunks (callback, rx = null, rz = null) {
  for (const key in mapping) {
    if (rx !== null && rz !== null) {
      if (Math.floor(mapping[key].pos.x / (16 * 32)) !== rx) continue;
      if (Math.floor(mapping[key].pos.z / (16 * 32)) !== rz) continue;
    }
    mapping[key].valid = true;
  }
  let validEntries;
  do {
    validEntries = await iterateMappedChunks(callback);
  } while (validEntries > 0);
}
// Recursive helper function for `forMappedChunks`
async function iterateMappedChunks (callback) {

  let _x, _z;
  for (const key in mapping) {
    const entry = mapping[key];
    if (!("valid" in entry)) continue;
    _x = Math.floor(entry.pos.x / 16);
    _z = Math.floor(entry.pos.z / 16);
    break;
  }

  const blocks = [];
  for (let x = 0; x < 16; x ++) {
    blocks[x] = [];
    for (let y = 0; y < 128 + 64; y ++) {
      blocks[x][y] = [];
      for (let z = 0; z < 16; z ++) {
        blocks[x][y][z] = "air";
      }
    }
  }


  let validEntries = Object.keys(mapping).length;
  const entries = [];

  for (const key in mapping) {
    const entry = mapping[key];
    if (!("valid" in entry)) {
      validEntries --;
      continue;
    }

    if (_x !== Math.floor(entry.pos.x / 16)) continue;
    if (_z !== Math.floor(entry.pos.z / 16)) continue;

    entries.push(entry);
    delete entry.valid;
    validEntries --;
  }

  const bounds = [
    new Vector(_x * 16, -64, _z * 16),
    new Vector(_x * 16 + 16, 128, _z * 16 + 16),
  ];

  await callback(blocks, entries, _x, _z, bounds);

  return validEntries;

}

// Returns number of allocated blocks adjacent to the given position
function countAdjacent (pos) {
  let adjacent = 0;
  for (let i = 0; i < 6; i ++) {
    if (pos.shifted(i).toString() in mapping) adjacent ++;
  }
  return adjacent;
};

/**
 * Generates terrain based on an input file list, and writes region data.
 * The resulting block-file mapping gets stored in `mapping`.
 *
 * @param {MappedFile[]} fileList - Array of file entries to map
 * @param {number} parentDepth - Depth of first significant parent path
 * @param {string} worldPath - Path to world data directory
 * @param {boolean} [debug=false] - Whether to use the debug palette
 */
async function buildRegionData (fileList, parentDepth, worldPath, debug = false) {

  // Open node list - `mapping` functions as the closed node list
  let nodes = [new Vector(0, 32, 0)];

  // Separate terrain "groups" by top-level directories
  let terrainGroup = 0;
  let lastParent = "";

  // Keep track of trees/water bodies to incorporate after the current
  // terrain group has finished generating.
  let trees = [], ponds = [];

  const [mins, maxs] = terrainBounds;

  // Used to suppress generation in a random direction for a random duration
  // This helps make the terrain less regular and diamond-shaped
  let suppressFor = 0;
  let suppressDirection = 0;

  // First pass - general terrain shape and features
  while (fileList.length > 0 && nodes.length > 0) {

    const pos = nodes.shift();
    const key = pos.toString();

    if (
      key in mapping ||
      pos.x < WORLD_BOUNDS[0].x || pos.x > WORLD_BOUNDS[1].x ||
      pos.y < WORLD_BOUNDS[0].y || pos.y > WORLD_BOUNDS[1].y ||
      pos.z < WORLD_BOUNDS[0].z || pos.z > WORLD_BOUNDS[1].z
    ) {
      if (nodes.length === 0) {
        const rand = new Vector();
        do {
          rand.x = Math.floor(Math.random() * (maxs.x - mins.x)) + mins.x;
          rand.z = Math.floor(Math.random() * (maxs.z - mins.z)) + mins.z;
          rand.y = Math.floor(Math.random() * 64);
        } while (rand.toString() in mapping);
        nodes.push(rand);
      }
      continue;
    }

    suppressFor --;
    if (suppressFor <= 0) {
      suppressFor = Math.floor(Math.random() * nodes.length / 5);
      suppressDirection = Math.floor(Math.random() * 4);
    }

    const file = fileList.shift();
    const shortParent = file.getShortParent(parentDepth);

    if (lastParent && lastParent !== shortParent) {

      nodes = [];
      terrainGroup ++;

      for (const pond of ponds) {

        const candidates = Object.values(mapping).filter(c => (
          c.pos.x === pond.x &&
          c.pos.z === pond.z
        ));
        candidates.sort((a, b) => b.pos.y - a.pos.y);
        pond.y = candidates[0].pos.y;

        const fillNodes = [pond];

        do {

          const curr = fillNodes.shift();
          const key = curr.toString();
          if (!(key in mapping)) continue;

          if (trees.find(c => (
            Math.abs(c.pos.x - curr.x) < 3 &&
            Math.abs(c.pos.z - curr.z) < 3
          ))) continue;

          const blockAbove = mapping[curr.add(0, 1, 0).toString()]?.block;
          if (isGroundBlock(blockAbove)) continue;

          let neighbors = 0;
          let skip = false;
          for (let i = 0; i < 6; i ++) {
            const shiftKey = curr.shifted(i).toString();
            const block = mapping[shiftKey]?.block;
            if (i < 4 && isAir(block)) {
              skip = true;
              break;
            }
            if (block === "water") neighbors ++;
          }
          if (skip) continue;

          mapping[key].block = "water";

          for (let i = 0; i < 4; i ++) {
            if (neighbors < 3 && Math.random() < 0.1) continue;
            fillNodes.push(curr.shifted(i));
          }
          if (curr.y < 127 && Math.random() < 0.05) fillNodes.push(curr.add(0, 1, 0));
          if (curr.y > -64 && Math.random() < 0.05) fillNodes.push(curr.add(0, -1, 0));

        } while (Math.floor(Math.random() * 2000) !== 0 && fillNodes.length > 0);

      }
      ponds = [];

      for (const tree of trees) {

        const candidates = Object.values(mapping).filter(c => (
          c.pos.x === tree.pos.x &&
          c.pos.z === tree.pos.z
        ));
        candidates.sort((a, b) => b.pos.y - a.pos.y);
        tree.pos.y = candidates[0].pos.y + 1;

        forTreeBlocks(tree.pos, function (pos, block) {
          const key = pos.toString();
          if (key in mapping) {
            fileList.push(tree.files.pop());
          } else {
            mapping[key] = { pos, block, file: tree.files.pop() };
          }
        });

      }
      trees = [];

    }
    if (lastParent !== shortParent) {
      console.log(`  Mapping "${shortParent}" to blocks`);
      lastParent = shortParent;
    }

    let block;
    if (debug) {
      block = debugPalette[terrainGroup % debugPalette.length];
    } else {
      block = "grass_block";
    }
    mapping[key] = { pos, file, block };

    if (pos.x < mins.x) mins.x = pos.x;
    else if (pos.x > maxs.x) maxs.x = pos.x;
    if (pos.y < mins.y) mins.y = pos.y;
    else if (pos.y > maxs.y) maxs.y = pos.y;
    if (pos.z < mins.z) mins.z = pos.z;
    else if (pos.z > maxs.z) maxs.z = pos.z;

    let adjacent = 0;
    for (let i = 0; i < 6; i ++) {
      if (pos.shifted(i).toString() in mapping) adjacent ++;
    }

    for (let i = 0; i < 4; i ++) {
      if (adjacent < 3 && suppressDirection === i) continue;
      nodes.push(pos.shifted(i));
    }
    if (pos.y < 127 && Math.random() < 0.05) nodes.push(pos.add(0, 1, 0));
    if (pos.y > -64 && Math.random() < 0.05) nodes.push(pos.add(0, -1, 0));

    if (Math.floor(Math.random() * 10000) === 0) {
      ponds.push(pos.clone());
    }

    if (Math.floor(Math.random() * 5000) === 0) {
      if (fileList.length < 62) continue;
      if (trees.find(c => (
        Math.abs(c.pos.x - pos.x) < 5 &&
        Math.abs(c.pos.z - pos.z) < 5
      ))) continue;
      trees.push({
        pos: pos.clone(),
        files: fileList.slice(0, 62)
      });
      fileList.splice(0, 62);
    }

  }

  // Second pass - make it look "Minecraft-ier" and generate region data
  await forMappedChunks(async function (blocks, entries, _x, _z, bounds) {

    console.log(`  Building data for chunk (${_x} ${_z})`);

    // Smooth out terrain by clumping together lonely blocks
    let swaps;
    do {
      swaps = 0;
      for (const entry of entries) {

        if (!isGroundBlock(entry.block)) continue;

        const pos = entry.pos;
        const adjacent = countAdjacent(pos);

        // Temporarily remove the current block's mapping entry
        // It can still be restored by assigning `entry`
        const key = pos.toString();
        delete mapping[key];

        let bestAdjacent = adjacent;
        let bestPosition;

        // Check all 6 directions for a better adjacent block score
        for (let i = 0; i < 6; i ++) {
          const abs = pos.shifted(i);
          const rel = abs.relative(_x, _z);
          // Make sure we're not stepping out of this chunk's boundaries
          if (
            rel.x < 0 || rel.x >= 16 ||
            rel.z < 0 || rel.z >= 16 ||
            rel.y < 0 || rel.y >= 128 + 64
          ) continue;
          // Abort if we're next to water
          const key = abs.toString();
          if (mapping[abs]?.block === "water") {
            bestAdjacent = adjacent;
            break;
          }
          // Make sure we're not shifting into an existing block
          if (key in mapping) continue;
          // Compare this cluster to the previous best
          const newAdjacent = countAdjacent(abs);
          if (newAdjacent <= bestAdjacent) continue;
          bestAdjacent = newAdjacent;
          bestPosition = { rel, abs };
        }

        // If no progress was made, restore previous mapping entry
        if (bestAdjacent === adjacent) {
          // Convert 1-block stubs to short grass
          if (adjacent === 1) {
            const blockBelow = mapping[pos.add(0, -1, 0).toString()]?.block;
            if (blockBelow === "grass_block") entry.block = "short_grass";
          }
          mapping[key] = entry;
          continue;
        }

        // Assign new block position
        entry.pos = bestPosition.abs;
        mapping[bestPosition.abs.toString()] = entry;

        swaps ++;

      }
    } while (swaps > 0);

    // Fill block array with relevant blocks
    for (const entry of entries) {
      // Convert covered grass blocks to dirt
      const blockAbove = mapping[entry.pos.add(0, 1, 0).toString()];
      if (entry.block === "grass_block" && isHeavyBlock(blockAbove?.block)) {
        entry.block = "dirt";
        // Convert deeply submerged blocks to stone
        let submerged = true;
        for (let i = 1; i <= 3; i ++) {
          const currBlock = mapping[entry.pos.add(0, i, 0).toString()]?.block;
          if (!isGroundBlock(currBlock)) {
            submerged = false;
            break;
          }
        }
        if (submerged) entry.block = "stone";
      }
      // Convert lonely blocks in ponds to water
      let waterAdjacent = 0;
      for (let i = 0; i < 6; i ++) {
        if (mapping[entry.pos.shifted(i).toString()]?.block === "water") {
          waterAdjacent ++;
        } else if (i < 4) {
          waterAdjacent = 0;
          break;
        }
      }
      if (waterAdjacent >= 5) entry.block = "water";
      // Assign block to chunk array
      const [x, y, z] = entry.pos.relative(_x, _z).toArray();
      blocks[x][y][z] = entry.block;
    }

    // Insert ore veins
    const veinCount = Math.floor(Math.random() * entries.length / 250);
    for (let i = 0; i < veinCount; i ++) {

      let curr = entries[Math.floor(Math.random() * entries.length)];
      const r = Math.random();

      let ore;
      if (r < 0.1) ore = { name: "diamond_ore", size: 0.5 };
      else if (r < 0.2) ore = { name: "lapis_ore", size: 0.5 };
      else if (r < 0.35) ore = { name: "gold_ore", size: 0.8 };
      else if (r < 0.5) ore = { name: "redstone_ore", size: 0.6 };
      else if (r < 0.7) ore = { name: "iron_ore", size: 0.8 };
      else ore = { name: "coal_ore", size: 0.9 };

      do {

        if (curr.block === "stone") {
          curr.block = ore.name;
          const [x, y, z] = curr.pos.relative(_x, _z).toArray();
          blocks[x][y][z] = curr.block;
        }

        const nextPos = curr.pos.shifted(Math.floor(Math.random() * 6));
        const nextPosRelative = nextPos.relative(_x, _z);
        if (
          nextPosRelative.x < 0 || nextPosRelative.x >= 16 ||
          nextPosRelative.y < -64 || nextPosRelative.y >= 320 ||
          nextPosRelative.z < 0 || nextPosRelative.z >= 16
        ) continue;

        curr = mapping[nextPos.toString()];
        if (!curr) break;

      } while (Math.random() < ore.size);

    }

    // Use backup path to load initial region data, effectively starting fresh
    const backupWorldPath = path.resolve(worldPath) + "_SaplingFS_backup";
    await world.forRegion(backupWorldPath, async function (region, rx, rz) {
      await world.blocksToRegion(blocks, region.bytes, rx, rz, bounds);
    }, bounds);

  });

  // Write new region data to disk
  const regionWritePromises = [];
  for (const mcaFile in world.regionFileCache) {
    const region = world.regionFileCache[mcaFile].bytes;
    regionWritePromises.push(
      Bun.write(`${worldPath}/region/${mcaFile}`, region)
    );
  }
  await Promise.all(regionWritePromises);

}

module.exports = {
  mapping,
  buildRegionData,
  forMappedChunks,
  terrainBounds
};
