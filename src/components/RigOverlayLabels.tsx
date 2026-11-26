import { HoveredRigBoneInfo, ProjectedRigNode } from '../types/weapon';

interface Props {
  nodes: ProjectedRigNode[];
  hoveredBone?: HoveredRigBoneInfo | null;
}

export function RigOverlayLabels({ nodes, hoveredBone }: Props) {
  const visible = nodes.filter((n) => n.visible);
  if (visible.length === 0 && !hoveredBone) return null;

  // Lightweight vertical collision avoidance so nearby socket labels never overlap
  const placed: Array<{ node: ProjectedRigNode; x: number; y: number }> = [];
  const sorted = [...visible].sort((a, b) => a.y - b.y);
  for (const node of sorted) {
    let lx = Math.round(node.x + 12);
    let ly = Math.round(node.y - 10);
    for (let pass = 0; pass < 4; pass++) {
      let collided = false;
      for (const prev of placed) {
        if (Math.abs(lx - prev.x) < 120 && Math.abs(ly - prev.y) < 20) {
          ly = prev.y + 21;
          collided = true;
        }
      }
      if (!collided) break;
    }
    placed.push({ node, x: lx, y: ly });
  }

  const leftWrist = visible.find((n) => n.name === 'LeftHand');

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden z-10">
      {placed.map(({ node, x, y }) => (
        <div
          key={node.name}
          style={{
            transform: `translate(${x}px, ${y}px)`,
            borderColor: `${node.color}aa`,
          }}
          className="absolute left-0 top-0 inline-flex items-center gap-1.5 rounded border bg-[#0B0E14]/92 px-1.5 py-0.5 text-[10px] font-medium tracking-tight text-[#EDF0F5] font-mono-tabular whitespace-nowrap shadow-md"
        >
          <span
            className="h-1.5 w-1.5 rounded-full shrink-0"
            style={{ backgroundColor: node.color }}
            aria-hidden="true"
          />
          <span>{node.shortLabel}</span>
        </div>
      ))}

      {hoveredBone && (
        <div
          style={{
            transform: `translate(${Math.round(hoveredBone.screenX + 14)}px, ${Math.round(
              hoveredBone.screenY - 12
            )}px)`,
          }}
          className="absolute left-0 top-0 z-30 rounded-md border border-[#2C3545] bg-[#0B0E14]/96 px-2 py-1 text-[11px] font-mono-tabular text-[#EDF0F5] shadow-lg whitespace-nowrap"
        >
          <span
            className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
            style={{ backgroundColor: hoveredBone.hand === 'right' ? '#34d399' : '#22d3ee' }}
            aria-hidden="true"
          />
          <span className="font-semibold">{hoveredBone.mixamoName}</span>
          <span className="ml-1.5 text-[#8A95A8]">({hoveredBone.name})</span>
        </div>
      )}

      <div className="hidden md:flex absolute bottom-16 left-4 flex-col gap-1 rounded-md border border-[#252D3D] bg-[#0B0E14]/88 px-2.5 py-1.5 text-[10px] text-[#B8C2D4] shadow-md backdrop-blur-xs">
        <div className="flex items-center gap-2 font-mono-tabular">
          <span className="h-1.5 w-1.5 rounded-full bg-[#34d399]" aria-hidden="true" />
          <span className="text-[#EDF0F5] font-medium">mixamorig:RightHand</span>
          <span className="text-[#8A95A8]">→ Thumb1..4 · Index1..4 · Middle1..4 · Ring1..4 · Pinky1..4</span>
        </div>
        <div className="flex items-center gap-2 font-mono-tabular">
          <span className="h-1.5 w-1.5 rounded-full bg-[#22d3ee]" aria-hidden="true" />
          <span className="text-[#EDF0F5] font-medium">
            {leftWrist?.shortLabel ?? 'mixamorig:LeftHand'}
          </span>
          <span className="text-[#8A95A8]">→ Hover joint to inspect bone</span>
        </div>
      </div>
    </div>
  );
}
