import React from "react";
import { Composition, registerRoot } from "remotion";
import { VideoComposition } from "./VideoComposition";
import type { AiPlan } from "./VideoComposition";

const DEFAULT_PROPS: AiPlan = {
  format:      "9:16",
  width:       720,
  height:      1280,
  hook_text:   "Votre accroche ici",
  cta_text:    "",
  music_style: "none",
  text_color:  "white",
  scenes: [
    {
      asset_url:  "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=720&h=1280&fit=crop",
      asset_type: "image",
      duration:   3,
      text:       "Scène exemple",
      transition: "cut",
    },
  ],
};

const RemotionRoot: React.FC = () => (
  <Composition
    id="VideoComposition"
    component={VideoComposition}
    fps={30}
    durationInFrames={90}
    width={720}
    height={1280}
    defaultProps={DEFAULT_PROPS}
    calculateMetadata={({ props }) => {
      const fps = 30;
      const scenes =
        Array.isArray(props.scenes) && props.scenes.length > 0
          ? props.scenes
          : DEFAULT_PROPS.scenes;
      const totalSecs = scenes.reduce(
        (acc: number, s: { duration: number }) => acc + (s.duration ?? 3),
        0,
      );
      return {
        fps,
        durationInFrames: Math.max(30, Math.round(totalSecs * fps)),
        width:  (props.width  as number) || 720,
        height: (props.height as number) || 1280,
      };
    }}
  />
);

registerRoot(RemotionRoot);
