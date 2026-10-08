"use client";

import { useEffect, useRef } from "react";

type Category = { id: string; name: string; gown_count: number };

export default function MergeDialog({
  source,
  targets,
  onClose,
  onMerge,
}: {
  source: Category | null;
  targets: Category[];
  onClose: () => void;
  onMerge: (targetId: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const select = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (source) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [source]);

  if (!source) return <dialog ref={dialog} aria-label="Merge category" />;
  return (
    <dialog ref={dialog} aria-labelledby="merge-title" onCancel={onClose}>
      <form method="dialog" className="merge-dialog" onSubmit={(event) => event.preventDefault()}>
        <h2 id="merge-title">Merge “{source.name}”</h2>
        <p>
          {source.gown_count} {source.gown_count === 1 ? "gown will" : "gowns will"} move into the
          selected value.
        </p>
        <label htmlFor="merge-target">Merge into</label>
        <select id="merge-target" ref={select} defaultValue="" required>
          <option value="" disabled>
            Select a value
          </option>
          {targets.map((target) => (
            <option value={target.id} key={target.id}>
              {target.name} ({target.gown_count} gowns)
            </option>
          ))}
        </select>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => select.current?.value && void onMerge(select.current.value)}
          >
            Merge
          </button>
        </div>
      </form>
    </dialog>
  );
}
