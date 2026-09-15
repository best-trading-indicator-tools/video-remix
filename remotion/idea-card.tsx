import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  cancelRender,
  continueRender,
  delayRender,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-700.css";

export type IdeaCardProps = {
  text: string;
  caption: string;
  width: number;
  height: number;
  duration: number;
};

const linesFor = (text: string, size: number, width: number) => {
  const columns = Math.max(1, Math.floor(width / (size * 0.7)));
  let lines = 1;
  let used = 0;
  for (const word of text.split(/\s+/u)) {
    const length = Array.from(word).reduce(
      (sum, char) => sum + (/[^\u0000-\u024f]/u.test(char) ? 2 : 1),
      0,
    );
    if (used && used + length + 1 > columns) {
      lines++;
      used = 0;
    }
    lines += Math.floor(Math.max(0, length - 1) / columns);
    used += (length % columns) + (used ? 1 : 0);
  }
  return lines;
};

/** Fixed authored artwork. Every user string is a React text node. */
export function IdeaCard({ text, caption }: IdeaCardProps) {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const [fontsReady] = useState(() => delayRender("Load local Inter fonts"));
  useEffect(() => {
    Promise.all([
      document.fonts.load('700 32px "Inter"'),
      document.fonts.load('400 16px "Inter"'),
    ]).then(() => continueRender(fontsReady), cancelRender);
  }, [fontsReady]);

  const short = Math.min(width, height);
  const inset = short * 0.095;
  const contentWidth = width - inset * 2;
  const gap = short * 0.04;
  let titleSize = short * (text.length > 100 ? 0.08 : 0.115);
  let captionSize = short * 0.042;
  // The lower quarter belongs to spoken-word captions in the final edit.
  while (
    titleSize > short * 0.018 &&
    linesFor(text, titleSize, contentWidth) * titleSize * 1.13 +
      (caption
        ? linesFor(caption, captionSize, contentWidth) * captionSize * 1.4 + gap
        : 0) >
      height * 0.39
  ) {
    titleSize *= 0.94;
    captionSize *= 0.97;
  }

  const entrance = spring({
    frame,
    fps,
    config: { damping: 22, stiffness: 130, mass: 0.8 },
  });
  const subtitle = spring({
    frame: frame - 5,
    fps,
    config: { damping: 24, stiffness: 120 },
  });
  const progress = frame / Math.max(1, durationInFrames - 1);
  const reveal = interpolate(
    frame,
    [0, Math.min(16, durationInFrames * 0.7)],
    [0, 1],
    { extrapolateRight: "clamp" },
  );
  const ink = "#16253b";
  const blue = "#2549dd";

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#f4f2eb",
        color: ink,
        fontFamily: "Inter, sans-serif",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          border: `${short * 0.022}px solid #e7e4da`,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: -short * 0.17,
          top: -short * 0.19,
          width: short * 0.62,
          height: short * 0.62,
          borderRadius: "50%",
          backgroundColor: "#e0e6ff",
          transform: `translate(${-progress * short * 0.06}px, ${progress * short * 0.035}px)`,
        }}
      />

      <div
        style={{
          position: "absolute",
          top: "17%",
          left: inset,
          width: short * 0.18,
          height: short * 0.014,
          backgroundColor: blue,
          transform: `scaleX(${reveal})`,
          transformOrigin: "left",
        }}
      />
      <svg
        aria-hidden
        width={short * 0.13}
        height={short * 0.13}
        viewBox="0 0 100 100"
        style={{
          position: "absolute",
          top: "12.5%",
          right: inset,
          transform: `rotate(${progress * 55 - 15}deg) scale(${0.82 + entrance * 0.18})`,
          opacity: entrance,
        }}
      >
        {[0, 45, 90, 135].map((rotation) => (
          <rect
            key={rotation}
            x="44"
            y="8"
            width="12"
            height="84"
            rx="6"
            fill={blue}
            transform={`rotate(${rotation} 50 50)`}
          />
        ))}
      </svg>

      <div
        style={{ position: "absolute", top: "26%", left: inset, right: inset }}
      >
        <h1
          style={{
            margin: 0,
            fontWeight: 700,
            fontSize: titleSize,
            lineHeight: 1.13,
            letterSpacing: "-0.045em",
            overflowWrap: "anywhere",
            whiteSpace: "normal",
            opacity: entrance,
            transform: `translateY(${(1 - entrance) * short * 0.08}px)`,
          }}
        >
          {text}
        </h1>
        {caption && (
          <p
            style={{
              margin: `${gap}px 0 0`,
              color: "#4a596b",
              fontSize: captionSize,
              lineHeight: 1.4,
              overflowWrap: "anywhere",
              opacity: subtitle,
              transform: `translateY(${(1 - subtitle) * short * 0.04}px)`,
            }}
          >
            {caption}
          </p>
        )}
      </div>

      <div
        style={{
          position: "absolute",
          top: "70%",
          left: inset,
          right: inset,
          height: Math.max(1, short * 0.003),
          backgroundColor: "#c8cfdb",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: -short * 0.006,
            left: `${progress * 76}%`,
            width: "24%",
            height: short * 0.015,
            backgroundColor: blue,
            opacity: entrance,
          }}
        />
      </div>
    </AbsoluteFill>
  );
}
