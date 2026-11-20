/**
 * Shard names: parsing, the shard-count limit and region codes, which the Worker router and matchmaking share.
 */
import { describe, expect, test } from "bun:test";
import {
  CONTINENTS,
  MAX_SHARDS_PER_REGION,
  isContinent,
  parseShardId,
  regionalShardId
} from "shared/shard-config";

describe("parseShardId", () => {
  test("accepts a shard name with or without a region", () => {
    expect(parseShardId("overworld-3")).toEqual({ continent: null, shard: 3 });
    expect(parseShardId("eu-overworld-3")).toEqual({ continent: "eu", shard: 3 });
  });

  test("accepts every shard from 1 up to the limit and nothing above it", () => {
    for (let shard = 1; shard <= MAX_SHARDS_PER_REGION; shard++) {
      expect(parseShardId(`na-overworld-${shard}`)).toEqual({ continent: "na", shard });
    }
    expect(parseShardId(`na-overworld-${MAX_SHARDS_PER_REGION + 1}`)).toBeNull();
    expect(parseShardId("na-overworld-0")).toBeNull();
    expect(parseShardId("na-overworld-999")).toBeNull();
  });

  test("raising the limit is the only change needed to allow more shards", () => {
    // The old pattern hard-coded 1-16 separately; the number must come only from MAX_SHARDS_PER_REGION.
    expect(parseShardId(`as-overworld-${MAX_SHARDS_PER_REGION}`)?.shard).toBe(MAX_SHARDS_PER_REGION);
  });

  test("rejects unknown regions and malformed names", () => {
    for (const bad of [
      "xx-overworld-1",
      "overworld-",
      "overworld-01",
      "overworld-+1",
      "overworld-1.5",
      "na-overworld-1-extra",
      "na_overworld-1",
      "NA-overworld-1",
      "na-overworld-1 ",
      " na-overworld-1",
      "",
      "not-a-room"
    ]) {
      expect(parseShardId(bad)).toBeNull();
    }
  });
});

describe("regions and ids", () => {
  test("every region code is recognized and anything else is not", () => {
    for (const c of CONTINENTS) expect(isContinent(c)).toBe(true);
    expect(isContinent("an")).toBe(false);
    expect(isContinent("NA")).toBe(false);
    expect(isContinent("")).toBe(false);
  });

  test("a built shard id parses back to the same parts", () => {
    for (const c of CONTINENTS) {
      expect(parseShardId(regionalShardId(c, 7))).toEqual({ continent: c, shard: 7 });
    }
  });
});
