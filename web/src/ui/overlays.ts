import { tagClass, type Ledger } from '../provenance/ledger';
import { esc } from './dom';

const REPO = 'https://github.com/TheBengineer/SonicMesh';

function closeOnClick(dialog: HTMLDialogElement): void {
  dialog.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target === dialog || target.closest('[data-close]')) dialog.close();
  });
}

export function renderAbout(dialog: HTMLDialogElement): void {
  dialog.innerHTML = `
    <button class="close" data-close aria-label="Close">Close</button>
    <h2>About SonicMesh</h2>
    <p>
      SonicMesh is a loose perimeter of low-cost microcontroller acoustic nodes. They detect small drones
      crossing at low altitude, and tell you where along the line, which way and when.
    </p>
    <p>
      This demo simulates the whole perimeter in the browser: terrain, trees, a drone you can fly, nodes you
      can place, and the gateway. Milestone M0 covers the world, flight, editing, record and replay, and the
      provenance ledger. Milestone M1 adds the acoustic engine: every mic hears the drone through a modelled
      path, and you can see its waterfall and listen to it. The node and gateway code arrive in later milestones.
      Each component is tagged in the badges and in the "What's real?" page.
    </p>
    <div class="links">
      <a href="${REPO}" target="_blank" rel="noopener">Repository on GitHub</a>
      <a href="${REPO}/blob/main/README.md" target="_blank" rel="noopener">README</a>
      <a href="${REPO}/blob/main/PLAN.md" target="_blank" rel="noopener">PLAN.md</a>
      <a href="${REPO}/blob/main/docs/web-demo-plan.md" target="_blank" rel="noopener">Web demo plan</a>
    </div>
  `;
  closeOnClick(dialog);
}

// `present` holds the ledger ids that the current scene shows.
export function renderLedger(dialog: HTMLDialogElement, ledger: Ledger, present: Set<string>): void {
  const counts = new Map<string, number>();
  for (const id of present) {
    const e = ledger.byId.get(id);
    if (e) counts.set(e.tag, (counts.get(e.tag) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([tag, n]) => `${n} ${tag}`).join(', ') || 'nothing';
  const rows = ledger.entries
    .map((e) => {
      let status: string;
      if (present.has(e.id)) status = '<span class="present">in this scene</span>';
      else if (e.milestone === 'M0') status = 'M0, not in this scene';
      else status = `planned for ${esc(e.milestone)}`;
      return `
        <tr>
          <td><strong>${esc(e.name)}</strong><br>${status}</td>
          <td><span class="badge ${tagClass(e.tag)}">${esc(e.tag)}</span></td>
          <td>${esc(e.summary)}</td>
          <td><a href="${esc(e.evidence)}" target="_blank" rel="noopener">evidence</a></td>
          <td>${esc(e.upgrade)}${e.bias ? `<br><em>Bias: ${esc(e.bias)}</em>` : ''}</td>
        </tr>`;
    })
    .join('');
  dialog.innerHTML = `
    <button class="close" data-close aria-label="Close">Close</button>
    <h2>What's real?</h2>
    <p>Every component has one tag. Badges in the inspector and legend read from the same file, provenance.yaml.</p>
    <div class="summary">In this scene: ${esc(summary)}</div>
    <table class="ledger">
      <thead>
        <tr><th>Component</th><th>Tag</th><th>What it is</th><th>Evidence</th><th>What would upgrade it, and known bias</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  closeOnClick(dialog);
}
