"use client";

import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { readApiError, readCsrfToken } from "./CategoryForm";

// KBS-21-5. Client side of spec/api/admin-images. The server stays the
// authority on type, size and count; checks here are only instant feedback.

type ImageStatus = "pending" | "ready" | "failed";
export type GownImage = {
  id: string;
  sort_order: number;
  is_hero: boolean;
  alt_text: string | null;
  width: number;
  height: number;
  status: ImageStatus;
};
type Upload = { key: string; file: File; progress: number; error: string | null };

const STATUS_LABEL: Record<ImageStatus, string> = {
  pending: "Processing",
  ready: "Ready",
  failed: "Failed",
};
const POLL_MS = 2000;

/** Instant feedback only; the server sniffs bytes. HEIC often has no MIME type in the browser. */
export function precheck(file: File, maxBytes: number): string | null {
  if (file.size > maxBytes) return `Larger than ${Math.floor(maxBytes / 1_048_576)} MB.`;
  if (file.type && !/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type))
    return "Upload a JPEG, PNG or WebP photo.";
  return null;
}

/** One file per request: fetch has no upload progress, XHR does. */
function uploadOne(url: string, file: File, onProgress: (pct: number) => void) {
  return new Promise<{ ok: true } | { ok: false; message: string }>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    const csrf = readCsrfToken();
    if (csrf) xhr.setRequestHeader("x-csrf-token", csrf);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve({ ok: true });
      const error = await readApiError(new Response(xhr.responseText, { status: xhr.status }));
      const field = error.fields ? Object.values(error.fields)[0] : undefined;
      resolve({ ok: false, message: field ?? error.message });
    };
    xhr.onerror = () => resolve({ ok: false, message: "Upload failed. Check your connection." });
    const body = new FormData();
    body.append("files", file);
    xhr.send(body);
  });
}

export default function GownImages({
  gownId,
  maxImages,
  maxBytes,
}: {
  gownId: string;
  maxImages: number;
  maxBytes: number;
}) {
  const base = `/api/admin/gowns/${encodeURIComponent(gownId)}/images`;
  const [images, setImages] = useState<GownImage[] | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const latest = useRef<GownImage[] | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const response = await fetch(base);
    if (!response.ok) throw new Error();
    const next = ((await response.json()) as { images: GownImage[] }).images;
    const changed = next.find((image) => {
      const before = latest.current?.find((p) => p.id === image.id);
      return before && before.status !== image.status;
    });
    if (changed)
      setAnnounce(`Photo ${changed.sort_order + 1} ${STATUS_LABEL[changed.status].toLowerCase()}.`);
    latest.current = next;
    setImages(next);
  }, [base]);

  useEffect(() => {
    load().catch(() => setNotice("Could not load photos. Try again."));
  }, [load]);

  const pending = images?.some((i) => i.status === "pending") ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => load().catch(() => undefined), POLL_MS);
    return () => clearInterval(timer);
  }, [pending, load]);

  const patch = (key: string, change: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...change } : u)));

  async function send(upload: Upload) {
    patch(upload.key, { progress: 0, error: null });
    const result = await uploadOne(base, upload.file, (progress) =>
      patch(upload.key, { progress }),
    );
    if (result.ok) {
      setUploads((list) => list.filter((u) => u.key !== upload.key));
      setAnnounce(`${upload.file.name} uploaded.`);
      await load().catch(() => undefined);
    } else {
      patch(upload.key, { error: result.message });
      setAnnounce(`${upload.file.name} failed: ${result.message}`);
    }
  }

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    setNotice(null);
    const room = maxImages - (images?.length ?? 0) - uploads.length;
    if (files.length > room) {
      setNotice(
        `A gown can have at most ${maxImages} photos. You can add ${Math.max(room, 0)} more; you chose ${files.length}.`,
      );
      return;
    }
    const batch = files.map((file) => ({
      key: `u${seq.current++}`,
      file,
      progress: 0,
      error: precheck(file, maxBytes),
    }));
    setUploads((list) => [...list, ...batch]);
    // Sequential: one slow file never starves the rest of bandwidth, and the
    // server's count check sees each file in order.
    for (const upload of batch) if (!upload.error) await send(upload);
  }

  async function retry(image: GownImage) {
    const csrf = readCsrfToken();
    const response = await fetch(`${base}/${encodeURIComponent(image.id)}/retry`, {
      method: "POST",
      headers: csrf ? { "x-csrf-token": csrf } : {},
    });
    if (!response.ok) setNotice((await readApiError(response)).message);
    await load().catch(() => undefined);
  }

  const full = (images?.length ?? 0) + uploads.length >= maxImages;

  return (
    <section className="gown-images" aria-labelledby="images-heading">
      <style>{css}</style>
      <h2 id="images-heading">Photos</h2>
      <p className="hint">
        JPEG, PNG or WebP, up to {Math.floor(maxBytes / 1_048_576)} MB each, {maxImages} photos per
        gown.
      </p>
      <label className="button-link upload-label">
        Add photos
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          multiple
          disabled={full}
          onChange={choose}
        />
      </label>
      {notice ? (
        <p className="notice" role="alert">
          {notice}
        </p>
      ) : null}
      <p className="visually-hidden" aria-live="polite">
        {announce}
      </p>

      {uploads.length ? (
        <ul className="image-list" aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.key}>
              <span className="image-name">{u.file.name}</span>
              {u.error ? (
                <>
                  <span className="form-error">{u.error}</span>
                  <span className="actions">
                    <button type="button" onClick={() => void send(u)}>
                      Retry {u.file.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => setUploads((list) => list.filter((x) => x.key !== u.key))}
                    >
                      Remove {u.file.name}
                    </button>
                  </span>
                </>
              ) : (
                <progress max={100} value={u.progress} aria-label={`Uploading ${u.file.name}`}>
                  {u.progress}%
                </progress>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {images?.length === 0 && !uploads.length ? <p>No photos yet.</p> : null}
      {images?.length ? (
        <ol className="image-list" aria-label="Photos">
          {images.map((image) => (
            <li key={image.id}>
              <span className="image-name">
                Photo {image.sort_order + 1}
                {image.is_hero ? " · Main photo" : ""}
              </span>
              <span className={`status status-${image.status}`}>{STATUS_LABEL[image.status]}</span>
              {image.status === "failed" ? (
                <span className="actions">
                  <button type="button" onClick={() => void retry(image)}>
                    Retry photo {image.sort_order + 1}
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

const css = `
.gown-images { display:grid; gap:1rem; border-top:1px solid var(--line); margin-top:2rem; padding-top:1.5rem; }
.upload-label { justify-self:start; position:relative; cursor:pointer; }
.upload-label input { position:absolute; inset:0; opacity:0; cursor:pointer; min-height:0; width:100%; }
.upload-label:focus-within { outline:2px solid var(--gold); outline-offset:2px; }
.upload-label:has(input:disabled) { opacity:.5; cursor:not-allowed; }
.image-list { list-style:none; padding:0; margin:0; }
.image-list li { display:flex; flex-wrap:wrap; gap:.5rem 1rem; align-items:center; border-bottom:1px solid var(--line); padding:.75rem 0; }
.image-name { flex:1 1 12rem; overflow-wrap:anywhere; }
.image-list progress { flex:1 1 10rem; height:.5rem; accent-color:var(--gold); }
.status-failed { color:var(--error); } .status-pending { color:var(--muted); }
.actions { display:flex; flex-wrap:wrap; gap:.5rem; }
.visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
@media (max-width:30rem) { .actions, .actions button, .upload-label { width:100%; } }
`;
