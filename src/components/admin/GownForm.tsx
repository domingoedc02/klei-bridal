"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { formatMinor, parsePriceToMinor } from "@/shared/money";
import { slugify } from "@/shared/slug";
import { readApiError, readCsrfToken } from "./CategoryForm";

// KBS-20-3. Codes against the spec/api `/api/admin/gowns` contract; the
// server (KBS-20-1/20-2) stays the authority on validation, slug uniqueness
// and publish rules — this form only shows what it says, in words.

type Gown = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  silhouette_id: string | null;
  material_ids: string[];
  collection_ids: string[];
  price_minor: number | null;
  currency: string;
  price_status: "priced" | "on_request" | "unlisted";
  slug_locked: boolean;
  is_in_stock: boolean;
  status: "draft" | "published" | "archived";
};
type GownRow = Pick<
  Gown,
  "id" | "name" | "slug" | "status" | "price_status" | "price_minor" | "currency" | "is_in_stock"
>;
type Tag = { id: string; name: string };
type Vocab = { silhouettes: Tag[]; materials: Tag[]; collections: Tag[] };
type FormState = {
  name: string;
  slug: string;
  slugTouched: boolean;
  description: string;
  silhouetteId: string;
  materialIds: string[];
  collectionIds: string[];
  price: string;
  priceStatus: Gown["price_status"];
  inStock: boolean;
};

const EMPTY: FormState = {
  name: "",
  slug: "",
  slugTouched: false,
  description: "",
  silhouetteId: "",
  materialIds: [],
  collectionIds: [],
  price: "",
  priceStatus: "priced",
  inStock: false, // made-to-order only: the safer default, it promises less
};

function fromGown(gown: Gown): FormState {
  return {
    name: gown.name,
    slug: gown.slug,
    slugTouched: true,
    description: gown.description ?? "",
    silhouetteId: gown.silhouette_id ?? "",
    materialIds: gown.material_ids,
    collectionIds: gown.collection_ids,
    price: gown.price_minor ? formatMinor(gown.price_minor, gown.currency) : "",
    priceStatus: gown.price_status,
    inStock: gown.is_in_stock,
  };
}

function priceLabel(gown: GownRow): string {
  if (gown.price_status === "priced" && gown.price_minor)
    return formatMinor(gown.price_minor, gown.currency);
  return gown.price_status === "on_request" ? "Price on request" : "Unlisted";
}

function send(url: string, method: string, body?: unknown) {
  const csrf = readCsrfToken();
  return fetch(url, {
    method,
    headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function GownList() {
  const [items, setItems] = useState<GownRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/gowns")
      .then(async (response) => {
        if (!response.ok) throw new Error();
        setItems(((await response.json()) as { items: GownRow[] }).items);
      })
      .catch(() => setNotice("Could not load gowns. Try again."));
  }, []);

  return (
    <>
      <style>{css}</style>
      <p>
        <Link className="button-link" href="/admin/gowns/new">
          New gown
        </Link>
      </p>
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      {items?.length === 0 ? <p>No gowns yet.</p> : null}
      <ul className="gown-list">
        {items?.map((gown) => (
          <li key={gown.id}>
            <Link href={`/admin/gowns/${gown.id}`}>{gown.name}</Link>
            <span>
              {gown.status === "published"
                ? "Published"
                : gown.status === "draft"
                  ? "Draft"
                  : "Archived"}
            </span>
            <span>{priceLabel(gown)}</span>
            <span>{gown.is_in_stock ? "In stock" : "Made to order only"}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function GownForm({ id }: { id: string | null }) {
  const router = useRouter();
  const [gown, setGown] = useState<Gown | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [vocab, setVocab] = useState<Vocab>({ silhouettes: [], materials: [], collections: [] });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [publishErrors, setPublishErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const load = async () => {
      const [silhouettes, materials, collections] = await Promise.all(
        (["silhouettes", "materials", "collections"] as const).map(async (type) => {
          const response = await fetch(`/api/admin/categories/${type}`);
          return response.ok ? ((await response.json()) as { items: Tag[] }).items : [];
        }),
      );
      setVocab({
        silhouettes: silhouettes ?? [],
        materials: materials ?? [],
        collections: collections ?? [],
      });
      if (!id) return;
      const response = await fetch(`/api/admin/gowns/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error();
      const loaded = (await response.json()) as Gown;
      setGown(loaded);
      setForm(fromGown(loaded));
    };
    load().catch(() => setNotice("Could not load this gown. Try again."));
  }, [id]);

  const set = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));
  const slugLocked = gown?.slug_locked ?? false;
  const parsedPrice = parsePriceToMinor(form.price);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setNotice(null);
    if (form.priceStatus === "priced" && parsedPrice === null) {
      setFields({ price_minor: "Enter a price such as 45,000.00, or choose price on request." });
      return;
    }
    setPending(true);
    try {
      const response = await send(
        gown ? `/api/admin/gowns/${gown.id}` : "/api/admin/gowns",
        gown ? "PATCH" : "POST",
        {
          name: form.name.trim(),
          ...(slugLocked ? {} : { slug: form.slug }),
          description: form.description.trim() || null,
          silhouette_id: form.silhouetteId || null,
          material_ids: form.materialIds,
          collection_ids: form.collectionIds,
          price_status: form.priceStatus,
          price_minor: form.priceStatus === "priced" ? parsedPrice : null,
          currency: "PHP",
          is_in_stock: form.inStock,
        },
      );
      if (!response.ok) {
        // Keep every typed value: only the error state changes.
        const error = await readApiError(response);
        setFields(error.fields ?? {});
        setNotice(error.message);
        return;
      }
      const saved = (await response.json()) as Gown;
      setFields({});
      setGown(saved);
      setForm(fromGown(saved));
      setNotice("Saved.");
      if (!gown) router.replace(`/admin/gowns/${saved.id}`);
    } catch {
      setNotice("Could not reach the server. Your changes are still here — try again.");
    } finally {
      setPending(false);
    }
  }

  async function setPublished(publish: boolean) {
    if (!gown || pending) return;
    setPending(true);
    setPublishErrors([]);
    try {
      const response = publish
        ? await send(`/api/admin/gowns/${gown.id}/publish`, "POST")
        : await send(`/api/admin/gowns/${gown.id}`, "PATCH", { status: "draft" });
      if (!response.ok) {
        const error = await readApiError(response);
        setPublishErrors([error.message, ...Object.values(error.fields ?? {})]);
        return;
      }
      const saved = (await response.json()) as Gown;
      setGown(saved);
      set({ slug: saved.slug, slugTouched: true }); // unsaved edits elsewhere stay
    } catch {
      setPublishErrors(["Could not reach the server. Try again."]);
    } finally {
      setPending(false);
    }
  }

  const error = (key: string) =>
    fields[key] ? (
      <span className="form-error" id={`${key}-error`}>
        {fields[key]}
      </span>
    ) : null;
  const describedBy = (key: string) =>
    fields[key] ? { "aria-invalid": true, "aria-describedby": `${key}-error` } : {};
  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <>
      <style>{css}</style>
      <form className="gown-form" onSubmit={(event) => void save(event)} noValidate>
        <div className="field">
          <label htmlFor="gown-name">Name</label>
          <input
            id="gown-name"
            value={form.name}
            required
            maxLength={200}
            onChange={(event) =>
              set({
                name: event.target.value,
                ...(form.slugTouched ? {} : { slug: slugify(event.target.value) }),
              })
            }
            {...describedBy("name")}
          />
          {error("name")}
        </div>

        <div className="field">
          <label htmlFor="gown-slug">Web address</label>
          <input
            id="gown-slug"
            value={form.slug}
            readOnly={slugLocked}
            aria-describedby="gown-slug-hint"
            onChange={(event) => set({ slug: slugify(event.target.value), slugTouched: true })}
            {...describedBy("slug")}
          />
          <span className="hint" id="gown-slug-hint">
            {slugLocked
              ? "Fixed once published, so shared links keep working."
              : `/gowns/${form.slug || "…"}`}
          </span>
          {error("slug")}
        </div>

        <div className="field">
          <label htmlFor="gown-description">Details</label>
          <textarea
            id="gown-description"
            rows={6}
            value={form.description}
            onChange={(event) => set({ description: event.target.value })}
            {...describedBy("description")}
          />
          {error("description")}
        </div>

        <fieldset>
          <legend>Price</legend>
          <label className="choice">
            <input
              type="radio"
              name="price-status"
              checked={form.priceStatus === "priced"}
              onChange={() => set({ priceStatus: "priced" })}
            />
            Exact price
          </label>
          <label className="choice">
            <input
              type="radio"
              name="price-status"
              checked={form.priceStatus === "on_request"}
              onChange={() => set({ priceStatus: "on_request" })}
            />
            Price on request
          </label>
          <label className="choice">
            <input
              type="radio"
              name="price-status"
              checked={form.priceStatus === "unlisted"}
              onChange={() => set({ priceStatus: "unlisted" })}
            />
            Unlisted
          </label>
          {form.priceStatus === "priced" ? (
            <div className="field">
              <label htmlFor="gown-price">Price in pesos</label>
              <input
                id="gown-price"
                inputMode="decimal"
                value={form.price}
                placeholder="45,000.00"
                onChange={(event) => set({ price: event.target.value })}
                onBlur={() => parsedPrice !== null && set({ price: formatMinor(parsedPrice) })}
                {...describedBy("price_minor")}
              />
              {parsedPrice !== null ? (
                <span className="hint">Shows as {formatMinor(parsedPrice)}</span>
              ) : null}
              {error("price_minor")}
            </div>
          ) : null}
          {error("price_status")}
        </fieldset>

        <fieldset>
          <legend>Availability</legend>
          <label className="choice">
            <input
              type="radio"
              name="availability"
              checked={!form.inStock}
              onChange={() => set({ inStock: false })}
            />
            Made to order only
          </label>
          <label className="choice">
            <input
              type="radio"
              name="availability"
              checked={form.inStock}
              onChange={() => set({ inStock: true })}
            />
            In stock
          </label>
          {error("is_in_stock")}
        </fieldset>

        <div className="field">
          <label htmlFor="gown-silhouette">Silhouette</label>
          <select
            id="gown-silhouette"
            value={form.silhouetteId}
            onChange={(event) => set({ silhouetteId: event.target.value })}
            {...describedBy("silhouette_id")}
          >
            <option value="">None</option>
            {vocab.silhouettes.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
          {error("silhouette_id")}
        </div>

        {(
          [
            ["Materials", "materialIds", "material_ids", vocab.materials],
            ["Collections", "collectionIds", "collection_ids", vocab.collections],
          ] as const
        ).map(([legend, key, field, tags]) => (
          <fieldset key={key}>
            <legend>{legend}</legend>
            {tags.length === 0 ? (
              <p className="hint">None yet — add them under Categories.</p>
            ) : null}
            <div className="choices">
              {tags.map((tag) => (
                <label className="choice" key={tag.id}>
                  <input
                    type="checkbox"
                    checked={form[key].includes(tag.id)}
                    onChange={() => set({ [key]: toggle(form[key], tag.id) })}
                  />
                  {tag.name}
                </label>
              ))}
            </div>
            {error(field)}
          </fieldset>
        ))}

        {notice ? (
          <p className="notice" role="status">
            {notice}
          </p>
        ) : null}
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : gown ? "Save changes" : "Create draft"}
        </button>
      </form>

      <section className="publish-row" aria-labelledby="publish-heading">
        <h2 id="publish-heading">
          {gown?.status === "published" ? "Published" : "Draft — not visible to brides"}
        </h2>
        <button
          type="button"
          disabled={!gown || pending}
          aria-describedby="publish-status"
          onClick={() => void setPublished(gown?.status !== "published")}
        >
          {gown?.status === "published" ? "Unpublish" : "Publish"}
        </button>
        <div id="publish-status" role="alert">
          {!gown ? <p className="hint">Create the draft first, then publish.</p> : null}
          {publishErrors.map((reason) => (
            <p className="form-error" key={reason}>
              {reason}
            </p>
          ))}
        </div>
      </section>
    </>
  );
}

const css = `
:root { --page:#F4F1EB; --ink:#2B2825; --muted:#5B544A; --line:#C9BCA3; --gold:#6E5420; --error:#8C3A2A; }
* { box-sizing:border-box; } body { margin:0; background:var(--page); color:var(--ink); font-family:Inter,system-ui,sans-serif; }
.admin-page { max-width:48rem; margin:0 auto; padding:clamp(1rem,4vw,3rem); }
h1,h2 { font-family:Fraunces,Georgia,serif; font-weight:400; } h1 { font-size:clamp(2rem,5vw,3.5rem); } h2 { font-size:1.25rem; margin:0; }
a { color:inherit; } :focus-visible { outline:2px solid var(--gold); outline-offset:2px; }
input,select,textarea,button { min-height:44px; max-width:100%; border:1px solid var(--line); border-radius:0; background:transparent; color:inherit; font:inherit; padding:.6rem .75rem; }
input[readonly] { color:var(--muted); border-style:dashed; } button { cursor:pointer; } button:disabled { cursor:not-allowed; opacity:.5; }
.button-link { display:inline-flex; align-items:center; min-height:44px; border:1px solid var(--ink); padding:.6rem 1rem; text-decoration:none; }
.gown-form { display:grid; gap:1.25rem; } .field { display:grid; gap:.4rem; } .field input,.field textarea,.field select { width:100%; }
fieldset { border:0; border-top:1px solid var(--line); margin:0; padding:1rem 0 0; display:grid; gap:.25rem; } legend { padding:0; font-weight:600; }
.choices { display:flex; flex-wrap:wrap; column-gap:1.5rem; } .choice { display:flex; align-items:center; gap:.6rem; min-height:44px; }
.choice input { min-height:0; width:1.25rem; height:1.25rem; accent-color:var(--gold); }
.hint { color:var(--muted); font-size:.9rem; overflow-wrap:anywhere; } .form-error { color:var(--error); margin:0; } .notice { border-inline-start:3px solid var(--gold); padding:.75rem; margin:0; }
.gown-form > button[type=submit] { justify-self:start; background:var(--ink); color:var(--page); border-color:var(--ink); }
.publish-row { display:flex; flex-wrap:wrap; align-items:center; gap:1rem; border-top:1px solid var(--line); margin-top:2rem; padding-top:1.5rem; }
#publish-status { flex:1 1 14rem; }
.gown-list { list-style:none; padding:0; } .gown-list li { display:flex; flex-wrap:wrap; gap:.5rem 1.5rem; align-items:baseline; border-bottom:1px solid var(--line); padding:1rem 0; }
.gown-list li a { flex:1 1 12rem; min-height:44px; display:inline-flex; align-items:center; font-family:Fraunces,Georgia,serif; font-size:1.15rem; } .gown-list li span { color:var(--muted); }
@media (max-width:30rem) { .gown-form > button[type=submit], .publish-row button { width:100%; } }
@media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto !important; transition-duration:.01ms !important; animation-duration:.01ms !important; animation-iteration-count:1 !important; } }
`;
