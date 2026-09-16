import { graphicSceneSchema, type GraphicScene } from "./graphic-scene.js";

const escape = (text: string) => text.replace(/[&<>"']/gu, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const round = (value: number) => Number(value.toFixed(3));
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Authored vector drawings. Model output selects names, never markup or code. */
function drawing(icon: GraphicScene["nodes"][number]["icon"]): string {
  const head = '<circle cx="50" cy="30" r="13"/><path d="M23 83v-9c0-28 54-28 54 0v9"/>';
  const drawings: Record<typeof icon, string> = {
    person: head,
    people: '<circle cx="50" cy="29" r="12"/><circle cx="20" cy="38" r="9"/><circle cx="80" cy="38" r="9"/><path d="M29 81v-9c0-25 42-25 42 0v9M7 77v-9c0-15 11-21 21-17M93 77v-9c0-15-11-21-21-17"/>',
    message: '<path d="M13 18h74v50H47L27 83V68H13Z"/><path d="M28 35h43M28 49h29"/><circle cx="82" cy="20" r="12" fill="var(--tint)"/><path d="m77 20 4 4 7-9"/>',
    phone: '<rect x="27" y="6" width="46" height="88" rx="9"/><path d="M42 14h16M44 85h12"/><path d="M12 30h55v28H34L21 69V58h-9Z" fill="var(--paper)"/><path d="M23 40h32M23 49h21"/>',
    heart: '<path d="M50 83 17 51C-5 28 27 2 50 29 73 2 105 28 83 51Z" fill="var(--tint)"/><path d="m19 51 18 0 8-16 12 31 8-15h18"/>',
    sun: '<circle cx="50" cy="50" r="22" fill="var(--tint)"/><path d="M50 5v12M50 83v12M5 50h12M83 50h12M18 18l9 9M73 73l9 9M18 82l9-9M73 27l9-9"/>',
    moon: '<path d="M70 12C14 6 5 74 49 87c22 7 41-3 47-22C42 83 30 26 70 12Z" fill="var(--tint)"/><path d="M80 18v14M73 25h14"/>',
    clock: '<circle cx="50" cy="50" r="37"/><path d="M50 24v28l20 12M50 13v6M13 50h6M81 50h6M50 81v6"/>',
    brain: '<path d="M49 20C36 4 18 16 23 30 4 31 5 52 18 56 6 76 29 91 48 77M51 20c13-16 31-4 26 10 19 1 18 22 5 26 12 20-11 35-30 21M50 18v65M22 31c12-2 14 5 13 11M17 56c12-3 23 3 22 14M78 31c-12-2-14 5-13 11M83 56c-12-3-23 3-22 14"/>',
    book: '<path d="M50 25C36 13 19 14 8 17v61c19-4 32-1 42 8 10-9 23-12 42-8V17c-11-3-28-4-42 8v61M20 33l18 5M20 47l18 5M62 38l18-5M62 52l18-5"/>',
    camera: '<path d="M9 29h22l9-13h24l9 13h18v54H9Z"/><circle cx="50" cy="56" r="18"/><circle cx="50" cy="56" r="9"/><path d="M76 39h7"/>',
    microphone: '<rect x="35" y="8" width="30" height="52" rx="15"/><path d="M22 44v4c0 39 56 39 56 0v-4M50 76v17M32 93h36M44 22h12M44 33h12"/>',
    leaf: '<path d="M82 10C24 12 7 37 22 68c28 28 64-4 60-58Z" fill="var(--tint)"/><path d="M14 91 65 35M35 69V47M35 68h23"/>',
    water: '<path d="M50 9C38 32 18 50 18 64a32 32 0 0 0 64 0C82 50 62 32 50 9Z" fill="var(--tint)"/><path d="M30 62c0 12 7 19 17 20"/>',
    shield: '<path d="M50 8 86 24v28c0 21-22 35-36 41-14-6-36-20-36-41V24Z"/><path d="m31 50 13 14 27-30"/>',
    money: '<rect x="8" y="24" width="84" height="53" rx="7"/><circle cx="50" cy="50" r="16"/><path d="M22 49v3M78 49v3M50 37v26M43 57c15 6 18-7 7-7-12 0-9-12 6-7"/>',
    check: '<circle cx="50" cy="50" r="36" fill="var(--tint)"/><path d="m29 49 15 17 30-34"/>',
    light: '<path d="M37 73c1-21-16-23-16-42 0-37 58-37 58 0 0 19-17 21-16 42ZM38 84h24M43 94h14M44 64V43l6 6 6-6v21"/>',
    target: '<circle cx="47" cy="53" r="36"/><circle cx="47" cy="53" r="23"/><circle cx="47" cy="53" r="8" fill="var(--tint)"/><path d="m48 52 35-35M83 17H67M83 17v16"/>',
  };
  return `<g fill="none" stroke="currentColor" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round">${drawings[icon]}</g>`;
}

function lines(text: string, limit: number): string[] {
  const units = (value: string) => Array.from(value).reduce((sum, char) =>
    sum + (/[^\u0000-\u024f]/u.test(char) ? 2 : /[MW@#%]/u.test(char) ? 1.7 : 1), 0);
  const chunks: string[] = [];
  for (const word of text.split(/\s+/u)) {
    let part = "";
    for (const char of word) {
      if (part && units(part + char) > limit) { chunks.push(part); part = ""; }
      part += char;
    }
    if (part) chunks.push(part);
  }
  const result = [""];
  for (const word of chunks) {
    if (result.at(-1) && units(`${result.at(-1)} ${word}`) > limit) result.push("");
    result[result.length - 1] += (result.at(-1) ? " " : "") + word;
  }
  return result;
}
function label(text: string, x: number, y: number, size: number, columns: number, color: string, weight = 700, maxWidth = Math.min(840, columns*size*.6), maxHeight = Infinity): string {
  let fitted = size;
  let wrapped = lines(text, Math.max(1, Math.floor(maxWidth/(fitted*.6))));
  while (fitted > 10 && (wrapped.length-1)*fitted*1.2 > maxHeight) {
    fitted *= .93;
    wrapped = lines(text, Math.max(1, Math.floor(maxWidth/(fitted*.6))));
  }
  return `<text x="${round(x)}" y="${round(y)}" text-anchor="middle" fill="${color}" font-size="${round(fitted)}" font-weight="${weight}">${wrapped.map((line, i) => `<tspan x="${round(x)}" dy="${i ? round(fitted * 1.2) : 0}">${escape(line)}</tspan>`).join("")}</text>`;
}

/** Same scene in both engines: CSS time for HyperFrames, explicit frame time for Remotion. */
export function graphicSceneSvg(raw: GraphicScene, width: number, height: number, time?: number, theme: "dark" | "paper" = "dark"): string {
  const scene = graphicSceneSchema.parse(raw);
  const H = 1000 * height / width, short = Math.min(1000, H), portrait = H > 1100;
  const paper = theme === "paper" ? "#f5f1e8" : "#101b24";
  const ink = theme === "paper" ? "#19334a" : "#eff5ef";
  const muted = theme === "paper" ? "#566c79" : "#a6bac4";
  const accent = theme === "paper" ? "#166b74" : "#91e0c8";
  const tint = theme === "paper" ? "#d6e9e2" : "#233f43";
  const surface = theme === "paper" ? "#fffdf8" : "#192d36";
  const titleY = H * .16, top = H * .31, areaHeight = H * .38;
  const at = (delay: number) => time === undefined ? 1 : clamp((time - delay) / .35);
  const reveal = (content: string, delay: number) => `<g opacity="${round(at(delay))}"${time === undefined ? ` style="animation:scene-reveal .35s ease-out ${round(delay)}s both"` : ""}>${content}</g>`;
  const icon = (name: GraphicScene["nodes"][number]["icon"], x: number, y: number, size: number, delay: number) => {
    const drift = time === undefined ? "" : ` translate(0 ${round(Math.sin(Math.max(0,time-delay)*2) * short*.003)})`;
    return `<g transform="translate(${round(x-size/2)} ${round(y-size/2)})${drift}"><g${time === undefined ? ' style="animation:scene-float 3s ease-in-out infinite alternate"' : ""}><g transform="scale(${round(size/100)})" color="${accent}">${drawing(name)}</g></g></g>`;
  };
  let body = "";
  if (scene.kind === "illustration") {
    const node = scene.nodes[0]!, cx = 500, cy = top + areaHeight * .38, size = Math.min(310, areaHeight * .6);
    body = reveal(`<circle cx="${cx}" cy="${round(cy)}" r="${round(size*.72)}" fill="${tint}"/><circle cx="${cx}" cy="${round(cy)}" r="${round(size*.9)}" fill="none" stroke="${accent}" stroke-opacity=".22" stroke-dasharray="3 14"/>${icon(node.icon,cx,cy,size,node.at)}${label(node.label,cx,cy+size*.94,short*.055,24,ink,700,840,H*.70-(cy+size*.94))}`,node.at);
  } else if (scene.kind === "bars") {
    const max = Math.max(...scene.nodes.map(node => node.value!)), x = 195, plot = 610;
    const row = areaHeight / scene.nodes.length;
    body = `<path d="M${x} ${round(top+20)}V${round(top+areaHeight)}" stroke="${muted}" stroke-width="2"/>${label("0",x,top+areaHeight+28,24,10,muted,400)}`;
    scene.nodes.forEach((node,i) => {
      const y=top+i*row, length=node.value!/max*plot, progress=at(node.at);
      body += reveal(`${label(node.label,500,y+short*.028,short*.038,28,ink,700,610,row*.14)}<rect x="${x}" y="${round(y+row*.34)}" width="${round(plot)}" height="${round(row*.35)}" rx="8" fill="${tint}"/><g transform="translate(${x} ${round(y+row*.34)})"><rect width="${round(length*progress)}" height="${round(row*.35)}" rx="8" fill="${accent}"${time===undefined ? ` style="animation:scene-grow .5s ease-out ${round(node.at)}s both;transform-origin:left"` : ""}/></g>${label(`${node.value} ${scene.unit}`,500,y+row*.9,short*.036,32,ink)}`,node.at);
    });
  } else {
    const count=scene.nodes.length, vertical=portrait && scene.kind==="process";
    const cardW=vertical ? 770 : 840/count-25, cardH=vertical ? areaHeight/count-36 : areaHeight*.86;
    scene.nodes.forEach((node,i) => {
      const cx=vertical ? 500 : 80+(i+.5)*840/count, cy=vertical ? top+(i+.5)*areaHeight/count : top+areaHeight*.46;
      const size=Math.min(170,cardW*.54,cardH*.54);
      let content=`<rect x="${round(cx-cardW/2)}" y="${round(cy-cardH/2)}" width="${round(cardW)}" height="${round(cardH)}" rx="24" fill="${surface}" stroke="${accent}" stroke-opacity=".25"/>`;
      if(vertical) {
        content+=icon(node.icon,cx-cardW*.30,cy,size,node.at)+label(node.label,cx+cardW*.11,cy-8,Math.min(40,short*.06),20,ink,700,cardW*.54,cardH*.38);
      } else {
        content+=icon(node.icon,cx,cy-cardH*.12,size,node.at)+label(node.label,cx,cy+cardH*.29,Math.min(36,cardW*.10),Math.floor(cardW/20),ink,700,cardW*.86,cardH*.15);
      }
      if(i>0 && scene.kind==="process") {
        const p=vertical ? `M500 ${round(cy-cardH/2-32)}v23m-8-8 8 8 8-8` : `M${round(cx-cardW/2-28)} ${round(cy)}h20m-8-8 8 8-8 8`;
        content+=`<path d="${p}" fill="none" stroke="${accent}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      body+=reveal(content,node.at);
    });
    if(scene.kind==="comparison") body+=label("/",500,top+areaHeight*.5,short*.048,3,muted);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 ${round(H)}" style="--paper:${paper};--tint:${tint};font-family:Inter,Arial,sans-serif;background:${paper}">
<style>@keyframes scene-reveal{from{opacity:0}to{opacity:1}}@keyframes scene-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}@keyframes scene-float{from{transform:translateY(-2px)}to{transform:translateY(2px)}}</style>
<rect width="1000" height="${round(H)}" fill="${paper}"/><path d="M80 ${round(H*.09)}h80" stroke="${accent}" stroke-width="6"/>
${label(scene.title,500,titleY,short*.064,portrait?25:42,ink,700,840,H*.115)}${body}
${label(scene.kind === "bars" ? "AS STATED BY THE SPEAKER" : "ILLUSTRATING THE SPOKEN IDEA",500,H*.74,short*.019,60,muted,400)}
</svg>`;
}
