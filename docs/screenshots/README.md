# README screenshots

Actual Remix Studio UI captured in Chrome on October 10, 2026. The workspace and editing screenshots use app revision `886aa4e`; the API setup screenshot shows the subsequent onboarding update. The screenshots use separate demonstration workspaces and the two sample inputs in [upscale-examples](../upscale-examples/). They are cropped browser captures, with no mock controls or simulated AI results.

| Image | Shows |
| --- | --- |
| [workspace.jpg](workspace.jpg) | Auto workspace with two selected videos, a live preview, the upscaling prompt, and batch rendering controls. The preview is source footage with a caption-style sample, not a rendered upscale. |
| [import-videos.jpg](import-videos.jpg) | File drop area, bulk URL input, and local file linking in Add videos. |
| [bulk-settings.jpg](bulk-settings.jpg) | Selected-video scope, with future-import defaults unchecked. |
| [ai-upscaler.jpg](ai-upscaler.jpg) | 4K selected, local processing, and the actual readiness result on an Apple Silicon Mac. Other hosts display their own device. |
| [prompt-upscale.jpg](prompt-upscale.jpg) | Built-in 4K prompt example targeting two videos. The proposal has not been submitted or applied in this capture. |
| [onboarding-api-keys.jpg](onboarding-api-keys.jpg) | First-run API setup explaining free Pixabay/Pexels access, the choice of low-cost paid DeepSeek, provider dependencies, and the Open Settings action. No keys are entered. |

## Refreshing the images

1. Build the app and run it with a separate `DATA_DIR` and unused port so screenshots do not change a personal workspace.
2. Import `docs/upscale-examples/closeup-1080p-before.mp4` and `docs/upscale-examples/motion-4k-before.mp4`. In Auto, check both videos, select **Selected videos**, choose landscape framing and full length, and set the AI upscaler to **2160p · 4K**.
3. Capture the workspace and relevant controls through the browser. Use the **AI upscale to 4K** prompt example without submitting a provider request. Capture Add videos before entering any local paths or URLs.
4. Crop to the section being explained, keep complete labels and controls, and check every image at its README display size. Keep relative image links and descriptive alt text in the root README.

For the API setup screenshot, open **Quick guide** and capture its first step. Use an empty demonstration workspace with no provider keys; leave the fields untouched.

## Footage credit

The workspace preview and source thumbnails contain excerpts from the *Sintel* trailer, © copyright Blender Foundation | [www.sintel.org](https://durian.blender.org/), licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). [Source video](https://download.blender.org/durian/trailer/sintel_trailer-1080p.mp4) · [Attribution details](https://durian.blender.org/sharing/).

Changes to the sample inputs: excerpted, downsampled, and compressed. The app displays a caption-style preview over the main image. No endorsement is implied. The separate comparison stills in [upscale-examples](../upscale-examples/) also show AI enlargement, cropping, and labels; their [manifest](../upscale-examples/manifest.json) records the render details.

## Desktop and guided setup

`desktop-setup.png` and `api-setup.png` were captured from the packaged Apple Silicon app on October 10, 2026. The desktop setup shows successful local installation, and Settings shows the provider links and connection controls with no saved credentials.

`central-ai-preview.png` shows a real 1080p AI sample in the packaged desktop player. The sample uses the same licensed Tears of Steel excerpt credited in the upscaler examples. No API key or paid generation was used.
