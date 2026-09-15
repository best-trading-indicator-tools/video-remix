import React from "react";
import { Composition, registerRoot } from "remotion";
import { IdeaCard, type IdeaCardProps } from "./idea-card";

function Root() {
  return (
    <Composition
      id="EditorialIdea"
      component={IdeaCard}
      fps={30}
      width={1080}
      height={1920}
      durationInFrames={90}
      defaultProps={
        {
          text: "One clear idea.",
          caption: "",
          width: 1080,
          height: 1920,
          duration: 3,
        } satisfies IdeaCardProps
      }
      calculateMetadata={({ props }) => ({
        width: props.width,
        height: props.height,
        durationInFrames: Math.round(props.duration * 30),
      })}
    />
  );
}

registerRoot(Root);
