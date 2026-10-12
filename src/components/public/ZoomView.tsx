"use client";

import { useEffect, useRef } from "react";
import { altFor, srcSet, ZOOM_WIDTH, type GalleryImage } from "@/shared/images";
import styles from "./GownGallery.module.css";

/** The zoom asset fills the viewport; the browser picks ≤2048px (decision/images §2.1). */
const ZOOM_SIZES = "100vw";

/**
 * Tap-to-zoom (gown-zoom). Native modal <dialog>: focus is trapped and
 * Escape fires `cancel` for free. Close returns focus to the opener (parent),
 * and the back gesture closes it (parent owns history).
 */
export default function ZoomView({
  gownName,
  images,
  index,
  onIndex,
  onClose,
}: {
  gownName: string;
  images: GalleryImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const swipeX = useRef<number | null>(null);
  const image = images[index]!;
  const total = images.length;
  const go = (step: number) => onIndex((index + step + total) % total);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  const alt = altFor(image, gownName, index, total);
  return (
    <dialog
      ref={dialog}
      className={styles.zoom}
      aria-label={`${gownName}, photograph ${index + 1} of ${total}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (total < 2) return;
        if (event.key === "ArrowRight") go(1);
        if (event.key === "ArrowLeft") go(-1);
      }}
      onPointerDown={(event) => {
        swipeX.current = event.clientX;
      }}
      onPointerUp={(event) => {
        const start = swipeX.current;
        swipeX.current = null;
        if (start === null || total < 2) return;
        const dx = event.clientX - start;
        if (Math.abs(dx) > 48) go(dx < 0 ? 1 : -1);
      }}
    >
      <button type="button" className={styles.close} onClick={onClose} autoFocus>
        Close
      </button>
      <picture key={image.id}>
        <source type="image/avif" srcSet={srcSet(image, "avif", ZOOM_WIDTH)} sizes={ZOOM_SIZES} />
        <source type="image/webp" srcSet={srcSet(image, "webp", ZOOM_WIDTH)} sizes={ZOOM_SIZES} />
        <img
          className={styles.zoomImg}
          srcSet={srcSet(image, "jpeg", ZOOM_WIDTH)}
          sizes={ZOOM_SIZES}
          width={image.width}
          height={image.height}
          alt={alt}
          decoding="async"
          style={image.lqip ? { backgroundImage: `url("${image.lqip}")` } : undefined}
        />
      </picture>
      {total > 1 ? (
        <>
          <button
            type="button"
            className={`${styles.arrow} ${styles.prev}`}
            onClick={() => go(-1)}
            aria-label="Previous photograph"
          >
            ‹
          </button>
          <button
            type="button"
            className={`${styles.arrow} ${styles.next}`}
            onClick={() => go(1)}
            aria-label="Next photograph"
          >
            ›
          </button>
        </>
      ) : null}
      <p className={styles.count} aria-live="polite">
        {index + 1} / {total}
      </p>
    </dialog>
  );
}
