import type { Metadata } from "next";
import Link from "next/link";
import { getRedirectError } from "next/dist/client/components/redirect";
import { RedirectType } from "next/dist/client/components/redirect-error";
import { RedirectStatusCode } from "next/dist/client/components/redirect-status-code";

import { listCatalogue } from "@/server/services/catalogue";
import {
  gownFilterQuerySchema,
  gownFilterQueryString,
  type GownFilterQuery,
} from "@/shared/schemas/gownFilters";
import FavouriteNameHydrator from "@/components/public/FavouriteNameHydrator";
import FavouriteButton from "@/components/public/FavouriteButton";
import { MEDIA_PREFIX } from "@/shared/images";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<SearchParams> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const raw = await searchParams;
  const parsed = gownFilterQuerySchema.safeParse(raw);
  const query = parsed.success ? gownFilterQueryString(parsed.data) : "";
  return {
    title: "Gowns",
    alternates: { canonical: `/gowns${query ? `?${query}` : ""}` },
  };
}

function imagePath(derivatives: unknown): string | undefined {
  if (!derivatives || typeof derivatives !== "object") return undefined;
  const entries = Object.entries(derivatives as Record<string, unknown>)
    .map(([width, formats]) => ({ width: Number(width), formats }))
    .filter(
      (entry): entry is { width: number; formats: Record<string, unknown> } =>
        Number.isInteger(entry.width) &&
        entry.width > 0 &&
        !!entry.formats &&
        typeof entry.formats === "object",
    )
    .sort((a, b) => a.width - b.width);
  const chosen =
    [...entries].reverse().find((entry) => typeof entry.formats.jpeg === "string") ??
    [...entries].reverse().find((entry) => typeof entry.formats.webp === "string");
  const path = chosen?.formats.jpeg ?? chosen?.formats.webp;
  return typeof path === "string" ? `${MEDIA_PREFIX}${path}` : undefined;
}

function money(priceMinor: number | null, currency: string, priceStatus: string) {
  return priceStatus === "priced" && priceMinor !== null
    ? `${currency} ${(priceMinor / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`
    : "Price on request";
}

function pageHref(query: GownFilterQuery, page: number) {
  const next = { ...query, page };
  const queryString = gownFilterQueryString(next);
  return `/gowns${queryString ? `?${queryString}` : ""}`;
}

function Vocabulary({
  query,
  catalogue,
}: {
  query: GownFilterQuery;
  catalogue: Awaited<ReturnType<typeof listCatalogue>>;
}) {
  return (
    <>
      {(["silhouettes", "materials", "collections"] as const).map((key) => {
        const param = key.slice(0, -1) as "silhouette" | "material" | "collection";
        return (
          <fieldset key={key}>
            <legend>{param[0]!.toUpperCase() + param.slice(1)}</legend>
            {catalogue.vocabulary[key].map((option) => (
              <label key={option.slug}>
                <input
                  type="checkbox"
                  name={param}
                  value={option.slug}
                  defaultChecked={query[param].includes(option.slug)}
                />
                {option.name}
              </label>
            ))}
          </fieldset>
        );
      })}
    </>
  );
}

export default async function GownsPage({ searchParams }: Props) {
  const raw = await searchParams;
  const parsed = gownFilterQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return (
      <main>
        <h1>Gowns</h1>
        <p role="alert">INVALID_QUERY</p>
        <Link href="/gowns">Reset filters</Link>
      </main>
    );
  }

  const catalogue = await listCatalogue(parsed.data);
  const { query } = catalogue;
  if (catalogue.canonicalized) {
    throw getRedirectError(
      `/gowns${gownFilterQueryString(query) ? `?${gownFilterQueryString(query)}` : ""}`,
      RedirectType.replace,
      302 as RedirectStatusCode,
    );
  }
  const queryString = gownFilterQueryString(query);

  return (
    <main>
      <h1>Gowns</h1>
      <p>Find a gown by shape, material, collection, or price.</p>
      <FavouriteNameHydrator gowns={catalogue.cards.map(({ id, name }) => ({ id, name }))} />
      <p data-filter-query={queryString}>
        {queryString ? `Active filters: ${queryString}` : "Showing all gowns."}
      </p>

      <form method="get" action="/gowns">
        <fieldset>
          <legend>Search</legend>
          <label>
            Search gowns <input name="q" defaultValue={query.q} maxLength={80} />
          </label>
        </fieldset>
        <Vocabulary query={query} catalogue={catalogue} />
        <fieldset>
          <legend>Filter gowns</legend>
          <label>
            Minimum price{" "}
            <input name="price_min" inputMode="numeric" defaultValue={query.price_min} />
          </label>
          <label>
            Maximum price{" "}
            <input name="price_max" inputMode="numeric" defaultValue={query.price_max} />
          </label>
          <label>
            <input
              type="checkbox"
              name="available"
              value="1"
              defaultChecked={query.available === "1"}
            />{" "}
            Available now
          </label>
          <label>
            Sort{" "}
            <select name="sort" defaultValue={query.sort}>
              <option value="newest">Newest</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
            </select>
          </label>
          <button type="submit">Apply filters</button> <Link href="/gowns">Clear all</Link>
        </fieldset>
      </form>

      {catalogue.cards.length === 0 ? (
        <section aria-live="polite">
          <h2>No gowns found</h2>
          <p>Try changing filters or search terms.</p>
          <Link href="/gowns">Reset filters</Link>
        </section>
      ) : (
        <>
          <ul aria-label="Gown results">
            {catalogue.cards.map((card) => {
              const src = card.image ? imagePath(card.image.derivatives) : undefined;
              return (
                <li key={card.id}>
                  <Link href={`/gowns/${card.slug}`}>
                    {src ? (
                      <img
                        src={src}
                        alt={card.image?.altText ?? card.name}
                        width={card.image?.width}
                        height={card.image?.height}
                        loading="lazy"
                      />
                    ) : null}
                    <h2>{card.name}</h2>
                    <p>{money(card.priceMinor, card.currency, card.priceStatus)}</p>
                    {card.isInStock ? <span>Available now</span> : null}
                  </Link>
                  <FavouriteButton gownId={card.id} gownName={card.name} />
                </li>
              );
            })}
          </ul>
          {catalogue.pageCount > 1 ? (
            <nav aria-label="Catalogue pages">
              {query.page > 1 ? <Link href={pageHref(query, query.page - 1)}>Previous</Link> : null}
              <span>
                {" "}
                Page {query.page} of {catalogue.pageCount}{" "}
              </span>
              {query.page < catalogue.pageCount ? (
                <Link href={pageHref(query, query.page + 1)}>Next</Link>
              ) : null}
            </nav>
          ) : null}
        </>
      )}
    </main>
  );
}
