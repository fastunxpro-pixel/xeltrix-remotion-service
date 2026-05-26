import React from "react";
import { Sequence, Img, useVideoConfig, useCurrentFrame, interpolate } from "remotion";
import { OffthreadVideo } from "remotion";

export interface Scene {
  asset_url:  string;
  asset_type: "image" | "video";
  duration:   number;
  text:       string;
  transition: string;
}

export interface AiPlan {
  format:      string;
  width:       number;
  height:      number;
  hook_text:   string;
  cta_text:    string;
  music_style: string;
  text_color:  string;
  scenes:      Scene[];
}

const SceneContent: React.FC<{
  scene:         Scene;
  isFirst:       boolean;
  isLast:        boolean;
  hookText:      string;
  ctaText:       string;
  textColor:     string;
  durationFrames: number;
}> = ({ scene, isFirst, isLast, hookText, ctaText, textColor, durationFrames }) => {
  const frame = useCurrentFrame();

  const scale = scene.asset_type === "image"
    ? interpolate(frame, [0, durationFrames], [1.0, 1.08], { extrapolateRight: "clamp" })
    : 1;

  const textOpacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft:  "clamp",
    extrapolateRight: "clamp",
  });

  const baseColor = textColor === "black" ? "#000000" : "#ffffff";

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden", backgroundColor: "#000" }}>
      <div style={{ width: "100%", height: "100%", transform: `scale(${scale})`, transformOrigin: "center center" }}>
        {scene.asset_type === "image" ? (
          <Img
            src={scene.asset_url}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <OffthreadVideo
            src={scene.asset_url}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        )}
      </div>

      <div style={{
        position: "absolute",
        inset: 0,
        background: "linear-gradient(to bottom, rgba(0,0,0,0.35) 0%, transparent 25%, transparent 60%, rgba(0,0,0,0.65) 100%)",
        pointerEvents: "none",
      }} />

      {isFirst && hookText ? (
        <div style={{
          position: "absolute",
          top: 80, left: 48, right: 48,
          opacity: textOpacity,
          color: baseColor,
          fontSize: 54, fontWeight: 800, lineHeight: 1.2,
          textShadow: "0 2px 12px rgba(0,0,0,0.7)",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}>
          {hookText}
        </div>
      ) : null}

      {scene.text ? (
        <div style={{
          position: "absolute",
          bottom: isLast && ctaText ? 160 : 80,
          left: 48, right: 48,
          opacity: textOpacity,
          color: baseColor,
          fontSize: 44, fontWeight: 700, lineHeight: 1.3,
          textShadow: "0 2px 10px rgba(0,0,0,0.7)",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}>
          {scene.text}
        </div>
      ) : null}

      {isLast && ctaText ? (
        <div style={{
          position: "absolute",
          bottom: 64, left: 48, right: 48,
          opacity: textOpacity,
          backgroundColor: "rgba(220,38,38,0.92)",
          color: "#ffffff",
          padding: "18px 28px",
          borderRadius: 14,
          fontSize: 38, fontWeight: 800, textAlign: "center",
          fontFamily: "system-ui, -apple-system, sans-serif",
          boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
        }}>
          {ctaText}
        </div>
      ) : null}
    </div>
  );
};

export const VideoComposition: React.FC<AiPlan> = (props) => {
  const { fps } = useVideoConfig();
  let currentFrame = 0;

  return (
    <div style={{ width: "100%", height: "100%", backgroundColor: "#000" }}>
      {props.scenes.map((scene, i) => {
        const start = currentFrame;
        const dur   = Math.max(1, Math.round((scene.duration ?? 3) * fps));
        currentFrame += dur;

        return (
          <Sequence key={i} from={start} durationInFrames={dur}>
            <SceneContent
              scene={scene}
              isFirst={i === 0}
              isLast={i === props.scenes.length - 1}
              hookText={props.hook_text ?? ""}
              ctaText={props.cta_text ?? ""}
              textColor={props.text_color ?? "white"}
              durationFrames={dur}
            />
          </Sequence>
        );
      })}
    </div>
  );
};
