"use client";

import { useCallback, useEffect, useState } from "react";
import CategoryForm, { readApiError, readCsrfToken, type CategoryType } from "./CategoryForm";
import MergeDialog from "./MergeDialog";

type Category = { id: string; name: string; slug: string; gown_count: number };

export default function CategoryList({ type }: { type: CategoryType }) {
  const [items, setItems] = useState<Category[]>([]);
  const [selected, setSelected] = useState<Category | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/${type}`);
      if (!response.ok) throw new Error("Could not load categories.");
      const body: unknown = await response.json();
      const list =
        body && typeof body === "object" && "items" in body ? (body.items as unknown) : [];
      setItems(Array.isArray(list) ? (list as Category[]) : []);
    } catch {
      setNotice("Could not load categories. Try again.");
    }
  }, [type]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(url: string, init: RequestInit) {
    setNotice(null);
    try {
      const csrf = readCsrfToken();
      const response = await fetch(url, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(csrf ? { "x-csrf-token": csrf } : {}),
          ...init.headers,
        },
      });
      if (!response.ok) {
        const error = await readApiError(response);
        setNotice(error.message);
        return false;
      }
      await load();
      return true;
    } catch {
      setNotice("Could not reach category service. Try again.");
      return false;
    }
  }

  async function rename(item: Category) {
    if (!editName.trim()) return;
    if (
      await mutate(`/api/admin/${type}/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName.trim() }),
      })
    )
      setEditing(null);
  }

  async function remove(item: Category) {
    if (await mutate(`/api/admin/${type}/${item.id}`, { method: "DELETE" }))
      setNotice(`${item.name} deleted.`);
  }

  async function merge(targetId: string) {
    if (!selected) return;
    if (
      await mutate(`/api/admin/${type}/${selected.id}/merge`, {
        method: "POST",
        body: JSON.stringify({ target_id: targetId }),
      })
    ) {
      setNotice(`${selected.name} merged.`);
      setSelected(null);
    }
  }

  const title = type[0]?.toUpperCase() + type.slice(1);
  return (
    <section aria-labelledby={`${type}-heading`}>
      <h2 id={`${type}-heading`}>{title}</h2>
      <CategoryForm type={type} onCreated={() => void load()} />
      {notice ? (
        <p role="status" className="notice">
          {notice}
        </p>
      ) : null}
      <ul className="category-list">
        {items.map((item) => (
          <li key={item.id}>
            {editing === item.id ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void rename(item);
                }}
              >
                <label htmlFor={`edit-${item.id}`}>Rename {item.name}</label>
                <input
                  id={`edit-${item.id}`}
                  value={editName}
                  onChange={(event) => setEditName(event.target.value)}
                  autoFocus
                />
                <button type="submit">Save</button>
                <button type="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <span className="category-value">
                <span>{item.name}</span>
                <span aria-label={`${item.gown_count} gowns`}>{item.gown_count} gowns</span>
              </span>
            )}
            {editing !== item.id ? (
              <span className="category-actions">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(item.id);
                    setEditName(item.name);
                  }}
                >
                  Rename
                </button>
                <button type="button" onClick={() => setSelected(item)}>
                  Merge
                </button>
                <button
                  type="button"
                  onClick={() => void remove(item)}
                  aria-describedby={item.gown_count > 0 ? `in-use-${item.id}` : undefined}
                >
                  Delete
                </button>
                {item.gown_count > 0 ? (
                  <span className="sr-only" id={`in-use-${item.id}`}>
                    Delete unavailable while gowns use this value; merge instead.
                  </span>
                ) : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {!items.length ? <p>No {type} yet.</p> : null}
      <MergeDialog
        source={selected}
        targets={items.filter((item) => item.id !== selected?.id)}
        onClose={() => setSelected(null)}
        onMerge={merge}
      />
    </section>
  );
}
