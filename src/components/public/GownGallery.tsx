"use client";

import { preload } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { altFor, heroFirst, largest, srcSet, type GalleryImage } from "@/shared/images";
import styles from "./GownGallery.module.css";
import ZoomView from "./ZoomView";

/**
 * Real layout widths (plan/design §3): edge-to-edge single column below
 * 1024px; constrained two-column pdp-wrap above, capped at 1440px.
 * A wrong value here makes a phone download the 2048px file (decision/images §2.2).
 */
export const GALLERY_SIZES = "(min-width: 1440px) 860px, (min-width: 1024px) 60vw, 100vw";

export default function GownGallery({ gownName, images }: { gownName: string; images: GalleryImage[] }) {
  const ordered = heroFirst(images);
  const [open, setOpen] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const hero = ordered[0];
  const heroHref = hero && largest(hero, "jpeg", 1024);
  if (hero && heroHref) {
    // Hero priority: preload the AVIF candidate the browser will actually pick.
    preload(heroHref, {
      as: "image",
      imageSrcSet: srcSet(hero, "avif"),
      imageSizes: GALLERY_SIZES,
      type: "image/avif",
      fetchPriority: "high",
    });
  }

  const show = useCallback((index: number, from: HTMLElement) => {
    opener.current = from;
    setOpen(index);
  }, []);
  const close = useCallback(() => {
    setOpen(null);
    opener.current?.focus();
  }, []);

  // Back gesture closes zoom (decision/images AC-4): one history entry per open.
  useEffect(() => {
    if (open === null) return;
    if (!(history.state as { kbsZoom?: boolean } | null)?.kbsZoom) {
      history.pushState({ ...(history.state ?? {}), kbsZoom: true }, "", `#photo-${open + 1}`);
    }
    const onPop = () => close();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [open, close]);

  const requestClose = useCallback(() => {
    if ((history.state as { kbsZoom?: boolean } | null)?.kbsZoom) history.back();
    else close();
  }, [close]);

  if (ordered.length === 0) return null;

  return (
    <section className={styles.gallery} aria-label={`${gownName} photographs`}>
      <ul className={styles.list}>
        {ordered.map((image, i) => {
          const alt = altFor(image, gownName, i, ordered.length);
          const zoomHref = largest(image, "jpeg");
          return (
            <li key={image.id} className={styles.item}>
              {/* No-JS: a plain link to the 2048px file. JS upgrades it to the zoom dialog. */}
              <a
                href={zoomHref}
                className={styles.zoomLink}
                aria-label={`Zoom: ${alt}`}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                  event.preventDefault();
                  show(i, event.currentTarget);
                }}
              >
                <picture>
                  <source type="image/avif" srcSet={srcSet(image, "avif")} sizes={GALLERY_SIZES} />
                  <source type="image/webp" srcSet={srcSet(image, "webp")} sizes={GALLERY_SIZES} />
                  <img
                    className={styles.img}
                    srcSet={srcSet(image, "jpeg")}
                    sizes={GALLERY_SIZES}
                    src={largest(image, "jpeg", 1024)}
                    width={image.width}
                    height={image.height}
                    alt={alt}
                    loading={i === 0 ? "eager" : "lazy"}
                    fetchPriority={i === 0 ? "high" : "auto"}
                    decoding={i === 0 ? "auto" : "async"}
                    style={image.lqip ? { backgroundImage: `url("${image.lqip}")` } : undefined}
                  />
                </picture>
              </a>
            </li>
          );
        })}
      </ul>
      {open !== null ? (
        <ZoomView
          gownName={gownName}
          images={ordered}
          index={open}
          onIndex={(i) => {
            setOpen(i);
            history.replaceState(history.state, "", `#photo-${i + 1}`);
          }}
          onClose={requestClose}
        />
      ) : null}
    </section>
  );
}
