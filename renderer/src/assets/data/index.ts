import type {
  BaseType,
  DropEntry,
  AugmentDataByAugment,
  AugmentDataByTradeId,
  Stat,
  StatMatcher,
  TranslationDict,
} from "./interfaces";
import { loadClientStrings } from "../client-string-loader";
import { useTradeData } from "@/web/background/TradeData";
import { GEM, ItemCategory } from "@/parser/meta";
import { ItemRarity } from "@/parser/ParsedItem";

export * from "./interfaces";

export let ITEM_DROP: DropEntry[];
export let CLIENT_STRINGS: TranslationDict;
export let CLIENT_STRINGS_REF: TranslationDict;
export let APP_PATRONS: Array<{ from: string; months: number; style: number }>;
export let AUGMENT_DATA_BY_AUGMENT: AugmentDataByAugment;
export let AUGMENT_DATA_BY_TRADE_ID: AugmentDataByTradeId;

export let AUGMENT_LIST: BaseType[];
export const HIGH_VALUE_AUGMENTS_HARDCODED = new Set<string>([]);

export let ITEM_BY_TRANSLATED: (
  ns: BaseType["namespace"],
  name: string,
) => BaseType[] | undefined = () => undefined;
export let ITEM_BY_REF: (
  ns: BaseType["namespace"],
  name: string,
) => BaseType[] | undefined = () => undefined;
export let ITEMS_ITERATOR: (
  includes: string,
  andIncludes?: string[],
) => Generator<BaseType> = function* () {};

export let GEM_NS_NAMES: () => Generator<string> = function* () {};
export let UNIQUE_NS_NAMES: () => Generator<string> = function* () {};
export let ITEM_NS_NAMES: () => Generator<string> = function* () {};

export let TRADE_TAG_TO_REF = new Map<string, string>();

export let STAT_BY_MATCH_STR: (
  name: string,
) => { matcher: StatMatcher; stat: Stat } | undefined = () => undefined;
export let STAT_BY_REF: (name: string) => Stat | undefined = () => undefined;
export let STATS_ITERATOR: (
  includes: string,
  andIncludes?: string[],
) => Generator<Stat> = function* () {};

let localAugmentFilter: (
  value: BaseType,
  index: number,
  array: BaseType[],
) => unknown | undefined = () => undefined;

export let TRADE_ITEM_BY_REF: (
  itemQuery: {
    baseType?: string;
    name?: string;
    rarity?: ItemRarity;
    category?: ItemCategory;
  },
  forceCraftable?: boolean,
) => BaseType[] | undefined = () => undefined;

export let TRADE_STAT_BY_STAT_ID: (tradeId: string) => boolean = () => false;
export let TRADE_STAT_BY_MATCH_STR: (
  name: string,
) => { [type: string]: string[] } | undefined = () => undefined;

function parseNdjson<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim()) out.push(JSON.parse(line) as T);
  }
  return out;
}

function makeIterator<T>(items: T[], serialized: string[]) {
  return function* (
    searchString: string,
    andIncludes: string[] = [],
  ): Generator<T> {
    for (let i = 0; i < items.length; i++) {
      if (
        serialized[i].includes(searchString) &&
        andIncludes.every((s) => serialized[i].includes(s))
      ) {
        yield items[i];
      }
    }
  };
}

function makeNameGenerator(items: BaseType[]): () => Generator<string> {
  return function* () {
    for (const item of items) yield item.name;
  };
}

async function loadItems(language: string) {
  const text = await (
    await fetch(`${import.meta.env.BASE_URL}data/${language}/items.ndjson`)
  ).text();
  const items = parseNdjson<BaseType>(text);
  const serialized = items.map((item) => JSON.stringify(item));

  const byName = new Map<string, BaseType[]>();
  const byRefName = new Map<string, BaseType[]>();
  for (const item of items) {
    const nk = `${item.namespace}::${item.name}`;
    const rk = `${item.namespace}::${item.refName}`;
    byName.set(nk, [...(byName.get(nk) ?? []), item]);
    byRefName.set(rk, [...(byRefName.get(rk) ?? []), item]);
  }

  ITEM_BY_TRANSLATED = (ns, name) => byName.get(`${ns}::${name}`);
  ITEM_BY_REF = (ns, name) => byRefName.get(`${ns}::${name}`);
  ITEMS_ITERATOR = makeIterator<BaseType>(items, serialized);

  GEM_NS_NAMES = makeNameGenerator(items.filter((i) => i.namespace === "GEM"));
  UNIQUE_NS_NAMES = makeNameGenerator(
    items.filter((i) => i.namespace === "UNIQUE"),
  );
  ITEM_NS_NAMES = makeNameGenerator(
    items.filter((i) => i.namespace === "ITEM"),
  );

  TRADE_TAG_TO_REF = new Map<string, string>();
  for (const item of items) {
    if (item.tradeTag) TRADE_TAG_TO_REF.set(item.tradeTag, item.refName);
  }
}

async function loadStats(language: string) {
  const text = await (
    await fetch(`${import.meta.env.BASE_URL}data/${language}/stats.ndjson`)
  ).text();
  const stats = parseNdjson<Stat>(text);
  const serialized = stats.map((s) => JSON.stringify(s));

  const byRef = new Map<string, Stat>();
  const byMatcher = new Map<string, { stat: Stat; matcher: StatMatcher }>();
  for (const stat of stats) {
    byRef.set(stat.ref, stat);
    for (const matcher of stat.matchers) {
      byMatcher.set(matcher.string, { stat, matcher });
      if (matcher.advanced) byMatcher.set(matcher.advanced, { stat, matcher });
    }
  }

  STAT_BY_REF = (ref) => byRef.get(ref);
  STAT_BY_MATCH_STR = (matchStr) => byMatcher.get(matchStr);
  STATS_ITERATOR = makeIterator<Stat>(stats, serialized);
}

// assertion, to avoid regressions in stats.ndjson
const DELAYED_STAT_VALIDATION = new Set<string>();
export function stat(text: string) {
  DELAYED_STAT_VALIDATION.add(text);
  return text;
}

export async function init(lang: string) {
  CLIENT_STRINGS_REF = await loadClientStrings("en");
  ITEM_DROP = await (
    await fetch(`${import.meta.env.BASE_URL}data/item-drop.json`)
  ).json();
  APP_PATRONS = await (
    await fetch(`${import.meta.env.BASE_URL}data/patrons.json`)
  ).json();

  await loadForLang(lang);

  let failed = false;
  const missing = [];

  for (const text of DELAYED_STAT_VALIDATION) {
    if (STAT_BY_REF(text) == null) {
      // throw new Error(`Cannot find stat: ${text}`);
      missing.push(text);
      failed = true;
    }
  }
  if (failed) {
    // throw new Error(
    //   `Cannot find stat${missing.length > 1 ? "s" : ""}: ${missing.join("\n")}`,
    // );
    console.log(
      "Cannot find stat" + (missing.length > 1 ? "s" : "") + missing.join("\n"),
    );
  }
  DELAYED_STAT_VALIDATION.clear();
}

export function setLocalAugmentFilter(
  filter: (value: BaseType, index: number, array: BaseType[]) => unknown,
) {
  localAugmentFilter = filter;
}

export async function loadForLang(lang: string) {
  CLIENT_STRINGS = await loadClientStrings(lang);
  await loadItems(lang);
  await loadStats(lang);
  loadUltraLateItems(localAugmentFilter);
  await loadTradeData();
}

export function loadUltraLateItems(
  augmentFilter: (value: BaseType, index: number, array: BaseType[]) => unknown,
) {
  const a = Array.from(ITEMS_ITERATOR('"craftable": {"category": "SoulCore"}'));
  const b = a.filter((r) => r.augment && r.augment.some((s) => s.tradeId));
  const c = b.map((r) => ({
    ...r,
    augment: r.augment!.filter((s) => s.tradeId),
  }));
  const d = c.filter(augmentFilter);

  AUGMENT_LIST = d;

  AUGMENT_DATA_BY_AUGMENT = augmentsToLookup(AUGMENT_LIST);

  AUGMENT_DATA_BY_TRADE_ID = augmentsToLookupTradeId(AUGMENT_LIST);
}

function augmentsToLookup(augmentList: BaseType[]): AugmentDataByAugment {
  const augmentDataByAugment: AugmentDataByAugment = {};

  for (const augment of augmentList) {
    if (!augment.augment) continue;
    for (const augmentStat of augment.augment) {
      const { categories, string: text, values, tradeId } = augmentStat;
      if (!tradeId) continue;
      if (!augmentDataByAugment[augment.refName]) {
        augmentDataByAugment[augment.refName] = [];
      }
      augmentDataByAugment[augment.refName].push({
        augment: augment.name,
        refName: augment.refName,
        baseStat: text,
        values,
        id: tradeId[0],
        categories,
        icon: augment.icon,
      });
    }
  }

  return augmentDataByAugment;
}

function augmentsToLookupTradeId(
  augmentList: BaseType[],
): AugmentDataByTradeId {
  const augmentDataByAugment: AugmentDataByTradeId = {};

  for (const augment of augmentList) {
    if (!augment.augment) continue;
    for (const augmentStat of augment.augment) {
      const { categories, string: text, values, tradeId } = augmentStat;
      if (!tradeId) continue;
      if (!augmentDataByAugment[tradeId[0]]) {
        augmentDataByAugment[tradeId[0]] = [];
      }
      augmentDataByAugment[tradeId[0]].push({
        augment: augment.name,
        baseStat: text,
        values,
        id: tradeId[0],
        categories,
        icon: augment.icon,
      });
    }
  }

  return augmentDataByAugment;
}

async function loadTradeData() {
  const trade = useTradeData();
  await trade.load(true);
  if (trade.error.value) {
    console.error("Failed to load trade data:", trade.error.value);
    return;
  }

  TRADE_ITEM_BY_REF = function (
    itemQuery: {
      baseType?: string;
      name?: string;
      rarity?: ItemRarity;
      category?: ItemCategory;
    },
    forceCraftable?: boolean,
  ): BaseType[] | undefined {
    trade.expressInterest();

    const items = trade.tradeItemData.value;

    let base: BaseType | undefined;
    const { baseType, name, rarity, category } = itemQuery;

    if (category && GEM.has(category)) {
      if (name && items.has(name)) {
        base = {
          name: name,
          refName: name,
          namespace: "GEM",
          icon: "%NOT_FOUND%",
          tags: [],
          gem: {},
        };
      }
    } else if (rarity === ItemRarity.Unique) {
      if (name && items.has(`${name} ${baseType}`)) {
        base = {
          name: name,
          refName: name,
          namespace: "UNIQUE",
          icon: "%NOT_FOUND%",
          tags: [],
          unique: {
            base: baseType!,
          },
        };
      }
    } else if (!baseType) {
      if (name && items.has(name)) {
        // TODO: currency works without tradeTag, just ninja only, see if that is fine
        const craftable = category
          ? { category }
          : forceCraftable
            ? { category: name as ItemCategory }
            : undefined;

        base = {
          name: name,
          refName: name,
          namespace: "ITEM",
          icon: "%NOT_FOUND%",
          tags: [],
          craftable,
        };
      }
    } else {
      if (items.has(baseType)) {
        base = {
          name: baseType,
          refName: baseType,
          namespace: "ITEM",
          icon: "%NOT_FOUND%",
          tags: [],
          craftable: { category: ItemCategory.Unknown },
        };
      }
    }

    return base ? [base] : undefined;
  };

  TRADE_STAT_BY_STAT_ID = function (tradeId: string) {
    trade.expressInterest();

    return trade.tradeStatDataSet.value.has(tradeId);
  };

  TRADE_STAT_BY_MATCH_STR = function (name: string) {
    trade.expressInterest();

    const statData = trade.tradeStatData.value;

    const stat = statData.get(name);
    if (!stat) return;

    // never going to write to these, just need to satisfy type
    return stat as {
      [x: string]: string[];
    };
  };
}

// Disable since this is export for tests
// eslint-disable-next-line @typescript-eslint/naming-convention
export const __testExports = {
  augmentsToLookup,
};
