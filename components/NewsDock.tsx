"use client";

import { useEffect, useState } from "react";
import type { LiveHeadline } from "@/lib/live-news";

function mark(source: string): string {
  if (/hugging face/i.test(source)) return "HF";
  if (/github/i.test(source)) return "GH";
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

export default function NewsDock({ headlines }: { headlines: LiveHeadline[] }) {
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    // New results announce themselves as compact source icons. The reader
    // opens only when the operator asks for it, so it never covers the core.
    setSelected(null);
  }, [headlines]);

  if (!headlines.length) return null;
  const item = selected === null ? null : headlines[selected];

  return (
    <aside className="pointer-events-auto absolute bottom-32 left-8 z-30 max-w-[390px]">
      {item ? (
        <div className="panel news-reader mb-3 rounded-2xl p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="label-lit">{item.source}</div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="label transition-colors hover:text-[color:var(--color-signal)]"
              aria-label="Close news reader"
            >
              Close
            </button>
          </div>
          <h2
            className="mt-3 text-[15px] leading-snug"
            style={{ color: "var(--color-ink)", fontFamily: "var(--font-display)" }}
          >
            {item.title}
          </h2>
          <div className="label mt-2">{new Date(item.at).toLocaleDateString()}</div>
          {item.summary ? (
            <p className="mt-3 line-clamp-5 text-[12px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
              {item.summary}
            </p>
          ) : null}
          <a
            href={item.link}
            target="_blank"
            rel="noreferrer noopener"
            className="chip mt-4 inline-block px-4 py-2 label-lit"
          >
            Read source ↗
          </a>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <span className="label mr-1">Live intel</span>
        {headlines.slice(0, 6).map((headline, index) => (
          <button
            key={`${headline.link}-${index}`}
            type="button"
            onClick={() => setSelected(index)}
            className="news-source-icon"
            style={{
              borderColor:
                selected === index
                  ? "var(--color-signal)"
                  : "rgba(62,194,255,0.25)",
              color:
                selected === index
                  ? "var(--color-ice)"
                  : "var(--color-ink-soft)",
            }}
            aria-label={`Read ${headline.title}`}
            title={headline.title}
          >
            {mark(headline.source)}
          </button>
        ))}
      </div>
    </aside>
  );
}
