import { state, ui } from './state.js';
import { toFileSrc } from './utils.js';
import { setGraphTransformEnabled, updateNavActiveState, focusPersonCluster } from './graph.js';
import { setMapVisibility } from './map.js';
import { hidePeopleToolbar } from './people.js';

const NS = 'http://www.w3.org/2000/svg';
const NODE_RADIUS = 42;
const LABEL_OFFSET = 20;
const GENERATION_GAP_Y = 220;
const SIBLING_GAP_X = 180;

let _svgEl = null;
let _nodesGroup = null;
let _edgesGroup = null;
let _bandContainer = null;
let _scrollArea = null;
let _nodePositions = new Map();
let _switchGroupByFn = null;
let _bandData = [];

async function focusClusterFromTree(personId, switchGroupByFn) {
    await focusPersonCluster(personId, switchGroupByFn, {
        source: 'tree',
        beforeFn: () => { closeFamilyTree(); hidePeopleToolbar(); },
    });
}

// --- Force-directed layout ---

function forceLayout(people, relationships, iterations = 200) {
    const positions = new Map();
    const generations = assignGenerations(people, relationships);

    const genGroups = new Map();
    people.forEach(p => {
        const gen = generations.get(p.id) || 0;
        if (!genGroups.has(gen)) genGroups.set(gen, []);
        genGroups.get(gen).push(p);
    });

    for (const [gen, group] of genGroups) {
        const genWidth = group.length * SIBLING_GAP_X;
        group.forEach((p, indexInGen) => {
            positions.set(p.id, {
                x: -genWidth / 2 + indexInGen * SIBLING_GAP_X + SIBLING_GAP_X / 2,
                y: gen * GENERATION_GAP_Y,
                vx: 0,
                vy: 0,
            });
        });
    }

    const relEdges = relationships.map(r => {
        const isChildParent = r.relationship_type === 'child-parent';
        return {
            source: isChildParent ? r.person_b_id : r.person_a_id,
            target: isChildParent ? r.person_a_id : r.person_b_id,
            type: isChildParent ? 'parent-child' : r.relationship_type,
        };
    });

    for (let iter = 0; iter < iterations; iter++) {
        const alpha = 1 - iter / iterations;
        const ids = Array.from(positions.keys());

        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const a = positions.get(ids[i]);
                const b = positions.get(ids[j]);
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const minDist = NODE_RADIUS * 5;
                if (dist < minDist) {
                    const force = ((minDist - dist) / dist) * alpha * 0.6;
                    const fx = dx * force;
                    const fy = dy * force;
                    a.vx -= fx; a.vy -= fy;
                    b.vx += fx; b.vy += fy;
                }
            }
        }

        for (const edge of relEdges) {
            const a = positions.get(edge.source);
            const b = positions.get(edge.target);
            if (!a || !b) continue;
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;

            if (edge.type === 'parent-child') {
                const idealDist = GENERATION_GAP_Y;
                const force = (dist - idealDist) / dist * alpha * 0.3;
                a.vx += dx * force; a.vy += dy * force;
                b.vx -= dx * force; b.vy -= dy * force;
                const genA = generations.get(edge.source) || 0;
                const genB = generations.get(edge.target) || 0;
                if (genA >= genB) {
                    const yPull = alpha * 0.5;
                    a.vy -= yPull * GENERATION_GAP_Y * 0.1;
                    b.vy += yPull * GENERATION_GAP_Y * 0.1;
                }
            } else if (edge.type === 'spouse') {
                const idealDist = SIBLING_GAP_X;
                const force = (dist - idealDist) / dist * alpha * 0.2;
                a.vx += dx * force;
                b.vx -= dx * force;
                const yDiff = b.y - a.y;
                a.vy += yDiff * alpha * 0.3;
                b.vy -= yDiff * alpha * 0.3;
            } else if (edge.type === 'sibling') {
                const idealDist = SIBLING_GAP_X;
                const force = (dist - idealDist) / dist * alpha * 0.15;
                a.vx += dx * force;
                b.vx -= dx * force;
                const yDiff = b.y - a.y;
                a.vy += yDiff * alpha * 0.4;
                b.vy -= yDiff * alpha * 0.4;
            }
        }

        for (const id of ids) {
            const p = positions.get(id);
            p.x += p.vx * 0.8;
            p.y += p.vy * 0.8;
            p.vx *= 0.6;
            p.vy *= 0.6;
        }
    }

    for (const p of people) {
        const pos = positions.get(p.id);
        if (!pos) continue;
        const gen = generations.get(p.id) || 0;
        pos.y = gen * GENERATION_GAP_Y;
    }

    const spouseOf = new Map();
    const parentOfChild = new Map();
    for (const r of relationships) {
        if (r.relationship_type === 'parent-child') {
            if (!parentOfChild.has(r.person_b_id)) parentOfChild.set(r.person_b_id, []);
            parentOfChild.get(r.person_b_id).push(r.person_a_id);
        } else if (r.relationship_type === 'spouse') {
            spouseOf.set(r.person_a_id, r.person_b_id);
            spouseOf.set(r.person_b_id, r.person_a_id);
        }
    }

    const childrenOfCouple = new Map();
    for (const r of relationships) {
        if (r.relationship_type === 'parent-child') {
            const parentId = r.person_a_id;
            const sp = spouseOf.get(parentId);
            const coupleKey = sp ? [parentId, sp].sort().join('|') : parentId;
            if (!childrenOfCouple.has(coupleKey)) childrenOfCouple.set(coupleKey, new Set());
            childrenOfCouple.get(coupleKey).add(r.person_b_id);
        }
    }

    function parentCenterX(id) {
        const pars = parentOfChild.get(id);
        if (!pars || pars.length === 0) return positions.get(id)?.x ?? 0;
        let sum = 0;
        for (const pid of pars) sum += positions.get(pid)?.x ?? 0;
        return sum / pars.length;
    }

    const minGap = NODE_RADIUS * 2 + LABEL_OFFSET + 40;
    const genGroups2 = new Map();
    for (const p of people) {
        const gen = generations.get(p.id) || 0;
        if (!genGroups2.has(gen)) genGroups2.set(gen, []);
        genGroups2.get(gen).push(p.id);
    }

    const sortedGens = Array.from(genGroups2.keys()).sort((a, b) => a - b);
    for (const gen of sortedGens) {
        const ids = genGroups2.get(gen);

        const ordered = [];

        const spouseIds = new Set();
        for (const id of ids) {
            const sp = spouseOf.get(id);
            if (sp && ids.includes(sp)) spouseIds.add(id);
        }

        const couplePairs = [];
        const coupledSet = new Set();
        for (const id of ids) {
            if (coupledSet.has(id)) continue;
            const sp = spouseOf.get(id);
            if (sp && ids.includes(sp) && !coupledSet.has(sp)) {
                couplePairs.push([id, sp]);
                coupledSet.add(id);
                coupledSet.add(sp);
            }
        }
        const singles = ids.filter(id => !coupledSet.has(id));

        const units = [];
        for (const [a, b] of couplePairs) {
            units.push({ ids: [a, b], anchorX: parentCenterX(a) });
        }
        for (const id of singles) {
            units.push({ ids: [id], anchorX: parentCenterX(id) });
        }
        units.sort((a, b) => a.anchorX - b.anchorX);

        let x = 0;
        for (const unit of units) {
            for (let i = 0; i < unit.ids.length; i++) {
                positions.get(unit.ids[i]).x = x;
                x += minGap;
            }
        }

        const allIds = units.flatMap(u => u.ids);
        const totalW = positions.get(allIds[allIds.length - 1]).x - positions.get(allIds[0]).x;
        const center = positions.get(allIds[0]).x + totalW / 2;
        for (const id of allIds) positions.get(id).x -= center;
    }

    return positions;
}

function assignGenerations(people, relationships) {
    const generations = new Map();
    const childrenOf = new Map();
    const parentsOf = new Map();
    const peerAdj = new Map();

    for (const r of relationships) {
        if (r.relationship_type === 'parent-child') {
            if (!childrenOf.has(r.person_a_id)) childrenOf.set(r.person_a_id, []);
            childrenOf.get(r.person_a_id).push(r.person_b_id);
            if (!parentsOf.has(r.person_b_id)) parentsOf.set(r.person_b_id, []);
            parentsOf.get(r.person_b_id).push(r.person_a_id);
        } else if (r.relationship_type === 'spouse' || r.relationship_type === 'sibling') {
            if (!peerAdj.has(r.person_a_id)) peerAdj.set(r.person_a_id, []);
            if (!peerAdj.has(r.person_b_id)) peerAdj.set(r.person_b_id, []);
            peerAdj.get(r.person_a_id).push(r.person_b_id);
            peerAdj.get(r.person_b_id).push(r.person_a_id);
        }
    }

    const hasParent = id => parentsOf.has(id);
    const hasAnyRelationship = id =>
        parentsOf.has(id) || childrenOf.has(id) || peerAdj.has(id);
    const hasPeerWithParent = id => {
        for (const peer of (peerAdj.get(id) || [])) {
            if (hasParent(peer)) return true;
        }
        return false;
    };

    const linkedPeople = people.filter(p => hasAnyRelationship(p.id));
    const trueRoots = linkedPeople.filter(p => !hasParent(p.id) && !hasPeerWithParent(p.id));
    const roots = trueRoots.length > 0 ? trueRoots : linkedPeople.filter(p => !hasParent(p.id));
    if (roots.length === 0 && linkedPeople.length > 0) roots.push(linkedPeople[0]);

    const queue = roots.map(r => r.id);
    for (const id of queue) generations.set(id, 0);

    while (queue.length > 0) {
        const id = queue.shift();
        const gen = generations.get(id);

        for (const kid of (childrenOf.get(id) || [])) {
            const needed = gen + 1;
            if (!generations.has(kid) || generations.get(kid) < needed) {
                generations.set(kid, needed);
                queue.push(kid);
            }
        }

        for (const peer of (peerAdj.get(id) || [])) {
            if (!generations.has(peer)) {
                generations.set(peer, gen);
                queue.push(peer);
            } else if (generations.get(peer) !== gen) {
                const maxPeerGen = Math.max(gen, generations.get(peer));
                generations.set(peer, maxPeerGen);
                generations.set(id, maxPeerGen);
            }
        }
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const r of relationships) {
            if (r.relationship_type !== 'parent-child') continue;
            const parentGen = generations.get(r.person_a_id);
            const childGen = generations.get(r.person_b_id);
            if (parentGen != null && childGen != null && childGen <= parentGen) {
                generations.set(r.person_b_id, parentGen + 1);
                changed = true;
            }
        }
        for (const r of relationships) {
            if (r.relationship_type === 'parent-child') continue;
            const genA = generations.get(r.person_a_id);
            const genB = generations.get(r.person_b_id);
            if (genA != null && genB != null && genA !== genB) {
                const maxGen = Math.max(genA, genB);
                generations.set(r.person_a_id, maxGen);
                generations.set(r.person_b_id, maxGen);
                changed = true;
            }
        }
    }

    const hasUnlinked = people.some(p => !generations.has(p.id));
    let unlinkedGen = -1;
    if (hasUnlinked) {
        const maxGen = generations.size > 0 ? Math.max(...generations.values()) : -1;
        unlinkedGen = maxGen + 2;
        for (const p of people) {
            if (!generations.has(p.id)) generations.set(p.id, unlinkedGen);
        }
    }

    generations._unlinkedGen = unlinkedGen;
    return generations;
}

// --- SVG rendering ---

function createSVG(container) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'family-tree-svg');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    _edgesGroup = document.createElementNS(NS, 'g');
    _edgesGroup.setAttribute('class', 'tree-edges');
    svg.appendChild(_edgesGroup);

    _nodesGroup = document.createElementNS(NS, 'g');
    _nodesGroup.setAttribute('class', 'tree-nodes');
    svg.appendChild(_nodesGroup);

    container.appendChild(svg);
    return svg;
}

function renderTreeNode(person, x, y) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', `tree-node${person.is_named ? ' tree-node-named' : ''}`);
    g.setAttribute('transform', `translate(${x}, ${y})`);
    g.setAttribute('data-person-id', person.id);
    g.style.cursor = 'pointer';

    const clipId = `clip-${person.id.replace(/[^a-zA-Z0-9]/g, '')}`;
    const defs = document.createElementNS(NS, 'defs');
    const clipPath = document.createElementNS(NS, 'clipPath');
    clipPath.setAttribute('id', clipId);
    const clipCircle = document.createElementNS(NS, 'circle');
    clipCircle.setAttribute('cx', '0');
    clipCircle.setAttribute('cy', '0');
    clipCircle.setAttribute('r', String(NODE_RADIUS));
    clipPath.appendChild(clipCircle);
    defs.appendChild(clipPath);
    g.appendChild(defs);

    const bgCircle = document.createElementNS(NS, 'circle');
    bgCircle.setAttribute('cx', '0');
    bgCircle.setAttribute('cy', '0');
    bgCircle.setAttribute('r', String(NODE_RADIUS + 3));
    bgCircle.setAttribute('class', 'tree-node-ring');
    g.appendChild(bgCircle);

    if (person.thumbnail_path) {
        const image = document.createElementNS(NS, 'image');
        image.setAttribute('href', toFileSrc(person.thumbnail_path));
        image.setAttribute('x', String(-NODE_RADIUS));
        image.setAttribute('y', String(-NODE_RADIUS));
        image.setAttribute('width', String(NODE_RADIUS * 2));
        image.setAttribute('height', String(NODE_RADIUS * 2));
        image.setAttribute('clip-path', `url(#${clipId})`);
        image.setAttribute('preserveAspectRatio', 'xMidYMid slice');
        g.appendChild(image);
    } else {
        const placeholder = document.createElementNS(NS, 'circle');
        placeholder.setAttribute('cx', '0');
        placeholder.setAttribute('cy', '0');
        placeholder.setAttribute('r', String(NODE_RADIUS));
        placeholder.setAttribute('class', 'tree-node-placeholder');
        g.appendChild(placeholder);

        const initial = document.createElementNS(NS, 'text');
        initial.setAttribute('text-anchor', 'middle');
        initial.setAttribute('dominant-baseline', 'central');
        initial.setAttribute('class', 'tree-node-initial');
        initial.textContent = (person.name || '?')[0].toUpperCase();
        g.appendChild(initial);
    }

    const nameLabel = document.createElementNS(NS, 'text');
    nameLabel.setAttribute('y', String(NODE_RADIUS + LABEL_OFFSET));
    nameLabel.setAttribute('text-anchor', 'middle');
    nameLabel.setAttribute('class', 'tree-node-name');
    nameLabel.textContent = person.name || 'Unknown';
    g.appendChild(nameLabel);

    g.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.linkingPerson) {
            if (state.linkingPerson.id === person.id) {
                cancelLinking();
                return;
            }
            showRelationshipModal(state.linkingPerson, person);
            return;
        }
        startLinking(person);
    });

    g.addEventListener('dblclick', async (e) => {
        e.stopPropagation();
        cancelLinking();
        if (_switchGroupByFn) {
            await focusClusterFromTree(person.id, _switchGroupByFn);
        }
    });

    return g;
}

function formatRelLabel(type) {
    if (type === 'parent-child') return 'Parent of';
    if (type === 'spouse') return 'Spouse of';
    if (type === 'sibling') return 'Sibling of';
    return type;
}

function createRelBadge(x, y, nameA, nameB, relType) {
    const label = `${nameA}  ${formatRelLabel(relType)}  ${nameB}`;
    const badge = document.createElementNS(NS, 'g');
    badge.setAttribute('class', 'tree-rel-badge');
    badge.setAttribute('transform', `translate(${x}, ${y})`);

    const text = document.createElementNS(NS, 'text');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('class', 'tree-rel-badge-text');
    text.textContent = label;
    badge.appendChild(text);

    const textLen = label.length * 6.2 + 24;
    const bgRect = document.createElementNS(NS, 'rect');
    bgRect.setAttribute('x', String(-textLen / 2));
    bgRect.setAttribute('y', '-13');
    bgRect.setAttribute('width', String(textLen));
    bgRect.setAttribute('height', '26');
    bgRect.setAttribute('rx', '13');
    bgRect.setAttribute('class', 'tree-rel-badge-bg');
    badge.insertBefore(bgRect, text);

    badge.style.display = 'none';
    return badge;
}

function selectEdge(g) {
    if (!_edgesGroup) return;
    const wasSelected = g.classList.contains('tree-edge-selected');
    _edgesGroup.querySelectorAll('.tree-edge-group, .tree-connector-group').forEach(el => {
        el.classList.remove('tree-edge-selected');
        const b = el.querySelector('.tree-rel-badge');
        if (b) b.style.display = 'none';
    });
    if (_nodesGroup) {
        _nodesGroup.querySelectorAll('.tree-node').forEach(n => n.classList.remove('tree-node-active'));
    }
    if (!wasSelected) {
        g.classList.add('tree-edge-selected');
        const b = g.querySelector('.tree-rel-badge');
        if (b) b.style.display = '';
        const personIds = (g.getAttribute('data-people') || '').split(',').filter(Boolean);
        if (_nodesGroup) {
            for (const pid of personIds) {
                const node = _nodesGroup.querySelector(`[data-person-id="${pid}"]`);
                if (node) node.classList.add('tree-node-active');
            }
        }
    }
}

function renderTreeEdge(rel, posA, posB, nameA, nameB) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'tree-edge-group');
    g.setAttribute('data-rel-id', String(rel.id));
    g.setAttribute('data-people', `${rel.person_a_id},${rel.person_b_id}`);

    const path = document.createElementNS(NS, 'path');
    const midX = (posA.x + posB.x) / 2;
    const midY = (posA.y + posB.y) / 2;

    let d, badgeX, badgeY;
    if (rel.relationship_type === 'spouse') {
        const arcBow = -35;
        d = `M ${posA.x} ${posA.y} Q ${midX} ${midY + arcBow}, ${posB.x} ${posB.y}`;
        badgeX = midX;
        badgeY = midY - NODE_RADIUS - LABEL_OFFSET - 28;
    } else if (rel.relationship_type === 'sibling') {
        const arcBow = 35;
        d = `M ${posA.x} ${posA.y} Q ${midX} ${midY + arcBow}, ${posB.x} ${posB.y}`;
        badgeX = midX;
        badgeY = midY + NODE_RADIUS + LABEL_OFFSET + 28;
    } else {
        d = `M ${posA.x} ${posA.y} C ${posA.x} ${midY}, ${posB.x} ${midY}, ${posB.x} ${posB.y}`;
        badgeX = midX;
        badgeY = midY;
    }
    path.setAttribute('d', d);

    let edgeClass = 'tree-edge';
    if (rel.relationship_type === 'parent-child') edgeClass += ' tree-edge-parent';
    else if (rel.relationship_type === 'spouse') edgeClass += ' tree-edge-spouse';
    else if (rel.relationship_type === 'sibling') edgeClass += ' tree-edge-sibling';
    path.setAttribute('class', edgeClass);
    g.appendChild(path);

    const hitArea = document.createElementNS(NS, 'path');
    hitArea.setAttribute('d', d);
    hitArea.setAttribute('class', 'tree-edge-hit');
    g.appendChild(hitArea);

    const badge = createRelBadge(badgeX, badgeY, nameA, nameB, rel.relationship_type);
    g.appendChild(badge);

    hitArea.addEventListener('mouseenter', () => path.classList.add('tree-edge-hover'));
    hitArea.addEventListener('mouseleave', () => path.classList.remove('tree-edge-hover'));
    hitArea.addEventListener('click', (e) => {
        e.stopPropagation();
        selectEdge(g);
    });

    return g;
}

function renderParentChildConnectors(relationships, positions, edgesGroup, people) {
    const parentChildRels = relationships.filter(r => r.relationship_type === 'parent-child');
    if (parentChildRels.length === 0) return;

    const nameOf = id => people.find(p => p.id === id)?.name || 'Unknown';

    const childParents = new Map();
    for (const r of parentChildRels) {
        if (!childParents.has(r.person_b_id)) childParents.set(r.person_b_id, new Set());
        childParents.get(r.person_b_id).add(r.person_a_id);
    }

    const coupleKey = (parents) => Array.from(parents).sort().join('|');

    const coupleChildren = new Map();
    for (const [childId, parents] of childParents) {
        const key = coupleKey(parents);
        if (!coupleChildren.has(key)) coupleChildren.set(key, { parents: Array.from(parents), children: [] });
        coupleChildren.get(key).children.push(childId);
    }

    for (const { parents, children } of coupleChildren.values()) {
        const parentPos = parents.map(id => positions.get(id)).filter(Boolean);
        if (parentPos.length === 0) continue;

        const parentMidX = parentPos.reduce((s, p) => s + p.x, 0) / parentPos.length;
        const parentY = parentPos[0].y + NODE_RADIUS;
        const parentNames = parents.map(nameOf).join(' & ');

        for (const childId of children) {
            const cp = positions.get(childId);
            if (!cp) continue;

            const childY = cp.y - NODE_RADIUS;
            const childName = nameOf(childId);

            const rels = parentChildRels.filter(r =>
                parents.includes(r.person_a_id) && r.person_b_id === childId
            );
            if (rels.length === 0) continue;

            const relIds = rels.map(r => r.id);

            const g = document.createElementNS(NS, 'g');
            g.setAttribute('class', 'tree-connector-group');
            g.setAttribute('data-people', [...parents, childId].join(','));
            g.setAttribute('data-rel-ids', relIds.join(','));

            const midY = (parentY + childY) / 2;
            const d = `M ${parentMidX} ${parentY} C ${parentMidX} ${midY}, ${cp.x} ${midY}, ${cp.x} ${childY}`;

            const path = document.createElementNS(NS, 'path');
            path.setAttribute('d', d);
            path.setAttribute('class', 'tree-connector');
            g.appendChild(path);

            const hitArea = document.createElementNS(NS, 'path');
            hitArea.setAttribute('d', d);
            hitArea.setAttribute('class', 'tree-edge-hit');
            g.appendChild(hitArea);

            hitArea.addEventListener('mouseenter', () => path.classList.add('tree-edge-hover'));
            hitArea.addEventListener('mouseleave', () => path.classList.remove('tree-edge-hover'));
            hitArea.addEventListener('click', (e) => {
                e.stopPropagation();
                selectEdge(g);
            });

            const badgeX = cp.x + NODE_RADIUS + 20;
            const badgeY = midY;
            const badge = createRelBadge(badgeX, badgeY, parentNames, childName, 'parent-child');
            g.appendChild(badge);

            edgesGroup.appendChild(g);
        }
    }
}

function renderGenerationBands(generations, positions, originX, originY, contentH) {
    if (!_bandContainer) return;
    _bandContainer.innerHTML = '';
    _bandData = [];

    const genSet = new Set(generations.values());
    const sortedGens = Array.from(genSet).sort((a, b) => a - b);
    if (sortedGens.length === 0) return;

    const genYs = sortedGens.map(gen => {
        const nodesInGen = Array.from(positions.entries())
            .filter(([id]) => generations.get(id) === gen);
        const y = nodesInGen.length > 0 ? nodesInGen[0][1].y : gen * GENERATION_GAP_Y;
        return { gen, y };
    });

    const standardBandH = GENERATION_GAP_Y;

    for (let i = 0; i < genYs.length; i++) {
        const { gen, y } = genYs[i];

        const nextIsUnlinked = i < genYs.length - 1 && genYs[i + 1].gen === generations._unlinkedGen;
        const isUnlinked = gen === generations._unlinkedGen;

        const bandTop = i === 0
            ? 0
            : (genYs[i - 1].gen === generations._unlinkedGen || gen === generations._unlinkedGen)
                ? genYs[i - 1].y + standardBandH / 2 - originY
                : (genYs[i - 1].y + y) / 2 - originY;

        const bandBottom = nextIsUnlinked
            ? y + standardBandH / 2 - originY
            : i === genYs.length - 1
                ? Math.max(y + standardBandH / 2 - originY, contentH)
                : (y + genYs[i + 1].y) / 2 - originY;

        const contentTop = i === 0 ? 0 : bandTop;
        const height = Math.max(bandBottom - contentTop, standardBandH);

        const band = document.createElement('div');
        band.className = `gen-band gen-band-${gen % 2 === 0 ? 'even' : 'odd'}`;
        band.style.height = `${height}px`;
        _bandContainer.appendChild(band);

        const label = document.createElement('span');
        label.className = 'gen-band-label';
        label.textContent = gen === generations._unlinkedGen ? 'Unlinked' : `Gen ${gen + 1}`;
        band.appendChild(label);

        _bandData.push({ el: band, contentTop, height });
    }

    syncBandPositions();
}

function syncBandPositions() {
    if (!_bandContainer || !_scrollArea || _bandData.length === 0) return;

    const inner = _scrollArea.querySelector('.tree-inner');
    if (!inner) return;

    const containerRect = _bandContainer.parentElement.getBoundingClientRect();
    const innerRect = inner.getBoundingClientRect();
    const offsetY = innerRect.top - containerRect.top;

    for (let i = 0; i < _bandData.length; i++) {
        const bd = _bandData[i];
        const top = Math.floor(offsetY + bd.contentTop);
        
        let height;
        if (i < _bandData.length - 1) {
            const nextTop = Math.floor(offsetY + _bandData[i + 1].contentTop);
            height = Math.max(nextTop - top, 0);
        } else {
            const bottom = Math.floor(offsetY + bd.contentTop + bd.height);
            height = Math.max(bottom - top, 0);
            // Last band gets a bottom border since we removed it from the shared class
            bd.el.style.borderBottom = '1px solid rgba(255, 255, 255, 0.04)';
        }

        bd.el.style.top = `${top}px`;
        bd.el.style.height = `${height}px`;
    }
}

function clearEdgeSelection() {
    if (!_edgesGroup) return;
    _edgesGroup.querySelectorAll('.tree-edge-group, .tree-connector-group').forEach(el => {
        el.classList.remove('tree-edge-selected');
        const b = el.querySelector('.tree-rel-badge');
        if (b) b.style.display = 'none';
    });
    if (_nodesGroup) {
        _nodesGroup.querySelectorAll('.tree-node').forEach(n => n.classList.remove('tree-node-active'));
    }
}

// --- Linking flow (click-based) ---

function startLinking(person) {
    state.linkingPerson = person;
    if (_svgEl) _svgEl.classList.add('tree-linking-mode');
    updateHint(`Select another person to link with ${person.name || 'this person'}. Click the same person or press Esc to cancel.`);
    const nodes = _nodesGroup?.querySelectorAll('.tree-node') || [];
    nodes.forEach(n => {
        const pid = n.getAttribute('data-person-id');
        if (String(pid) === String(person.id)) n.classList.add('tree-link-source');
    });
}

function cancelLinking() {
    state.linkingPerson = null;
    if (_svgEl) _svgEl.classList.remove('tree-linking-mode');
    updateHint('Click a person to start linking \u00b7 Double-click to view photos \u00b7 Delete key to remove selected link');
    const nodes = _nodesGroup?.querySelectorAll('.tree-node') || [];
    nodes.forEach(n => n.classList.remove('tree-link-source'));
}

let _hintEl = null;
function updateHint(text) {
    if (_hintEl) _hintEl.textContent = text;
}

function resetRelTypeDropdown() {
    const dd = ui.relTypeDropdown;
    if (!dd) return;
    const items = dd.querySelectorAll('.dropdown-item');
    const label = dd.querySelector('.dropdown-label');
    items.forEach(i => {
        const isDefault = i.getAttribute('data-value') === 'parent-child';
        i.classList.toggle('active', isDefault);
        i.setAttribute('aria-selected', String(isDefault));
    });
    if (label) label.textContent = 'Parent of';
}

function getRelTypeValue() {
    const dd = ui.relTypeDropdown;
    if (!dd) return 'parent-child';
    const active = dd.querySelector('.dropdown-item.active');
    return active ? active.getAttribute('data-value') : 'parent-child';
}

function initRelTypeDropdown() {
    const dd = ui.relTypeDropdown;
    if (!dd || dd._initialized) return;
    dd._initialized = true;

    const trigger = dd.querySelector('.dropdown-trigger');
    const menu = dd.querySelector('.dropdown-menu');
    const label = dd.querySelector('.dropdown-label');
    const items = Array.from(dd.querySelectorAll('.dropdown-item'));
    if (!trigger || !menu) return;

    function isOpen() { return menu.classList.contains('show'); }

    function openMenu() {
        menu.classList.add('show');
        trigger.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
    }

    function closeMenu() {
        menu.classList.remove('show');
        trigger.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
    }

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        isOpen() ? closeMenu() : openMenu();
    });

    items.forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            items.forEach(i => { i.classList.remove('active'); i.setAttribute('aria-selected', 'false'); });
            item.classList.add('active');
            item.setAttribute('aria-selected', 'true');
            if (label) label.textContent = item.textContent;
            closeMenu();
        });
    });

    document.addEventListener('click', () => { if (isOpen()) closeMenu(); });
}

function showRelationshipModal(personA, personB) {
    if (!ui.relationshipModal) return;

    const thumbA = ui.relPersonA.querySelector('.rel-person-thumb');
    const nameA = ui.relPersonA.querySelector('.rel-person-name');
    if (thumbA) thumbA.src = personA.thumbnail_path ? toFileSrc(personA.thumbnail_path) : '';
    if (nameA) nameA.textContent = personA.name || 'Unknown';

    const thumbB = ui.relPersonB.querySelector('.rel-person-thumb');
    const nameB = ui.relPersonB.querySelector('.rel-person-name');
    if (thumbB) thumbB.src = personB.thumbnail_path ? toFileSrc(personB.thumbnail_path) : '';
    if (nameB) nameB.textContent = personB.name || 'Unknown';

    resetRelTypeDropdown();
    ui.relationshipModal.classList.remove('hidden');

    cancelLinking();

    const cleanup = () => {
        ui.relSaveBtn.onclick = null;
        ui.relCancelBtn.onclick = null;
        if (ui.relCloseBtn) ui.relCloseBtn.onclick = null;
        ui.relationshipModal.classList.add('hidden');
    };

    ui.relSaveBtn.onclick = async () => {
        const rawType = getRelTypeValue();
        let aId = personA.id;
        let bId = personB.id;
        let type = rawType;

        if (rawType === 'child-parent') {
            aId = personB.id;
            bId = personA.id;
            type = 'parent-child';
        }

        try {
            await window.api.invoke('add-relationship', { personAId: aId, personBId: bId, type });
            cleanup();
            await refreshTree();
        } catch (err) {
            console.error('Failed to save relationship:', err);
            let msg = err?.message || 'Failed to save relationship';
            const ipcPrefix = /^Error invoking remote method '[^']+': (Error: )?/;
            msg = msg.replace(ipcPrefix, '');
            if (ui.status) {
                ui.status.innerText = msg;
                ui.status.style.opacity = '1';
                setTimeout(() => { ui.status.style.opacity = '0'; }, 4000);
            }
        }
    };

    ui.relCancelBtn.onclick = cleanup;
    if (ui.relCloseBtn) ui.relCloseBtn.onclick = cleanup;
}

// --- BFS path-finding + highlight ---

function buildAdjacency(relationships) {
    const adj = new Map();
    for (const r of relationships) {
        if (!adj.has(r.person_a_id)) adj.set(r.person_a_id, []);
        if (!adj.has(r.person_b_id)) adj.set(r.person_b_id, []);
        adj.get(r.person_a_id).push({ to: r.person_b_id, rel: r });
        adj.get(r.person_b_id).push({ to: r.person_a_id, rel: r });
    }
    return adj;
}

export function findPath(relationships, sourceId, targetId) {
    if (sourceId === targetId) return [sourceId];
    const adj = buildAdjacency(relationships);
    const visited = new Set([sourceId]);
    const queue = [{ id: sourceId, path: [sourceId] }];

    while (queue.length > 0) {
        const { id, path } = queue.shift();
        const neighbors = adj.get(id) || [];
        for (const { to } of neighbors) {
            if (visited.has(to)) continue;
            const newPath = [...path, to];
            if (to === targetId) return newPath;
            visited.add(to);
            queue.push({ id: to, path: newPath });
        }
    }
    return [];
}

export function highlightPath(personIds) {
    clearHighlight();
    if (!personIds || personIds.length < 2) return;
    if (!state.treeData) return;

    const pathNodeIds = new Set();
    const pathRelIds = new Set();

    for (let i = 0; i < personIds.length - 1; i++) {
        const segment = findPath(state.treeData.relationships, personIds[i], personIds[i + 1]);
        segment.forEach(id => pathNodeIds.add(id));
    }

    for (const rel of state.treeData.relationships) {
        if (pathNodeIds.has(rel.person_a_id) && pathNodeIds.has(rel.person_b_id)) {
            pathRelIds.add(rel.id);
        }
    }

    if (_svgEl) _svgEl.classList.add('tree-highlight-active');

    const nodes = _nodesGroup?.querySelectorAll('.tree-node') || [];
    nodes.forEach(n => {
        const pid = n.getAttribute('data-person-id');
        if (pathNodeIds.has(pid) || pathNodeIds.has(Number(pid))) {
            n.classList.add('tree-highlighted-node');
        }
    });

    const edges = _edgesGroup?.querySelectorAll('.tree-edge-group') || [];
    edges.forEach(g => {
        const id = parseInt(g.getAttribute('data-rel-id'), 10);
        if (pathRelIds.has(id)) {
            g.classList.add('tree-highlighted-edge');
        }
    });

    state.highlightedPath = personIds;
    setTimeout(() => {
        if (state.highlightedPath === personIds) clearHighlight();
    }, 6000);
}

export function clearHighlight() {
    state.highlightedPath = [];
    if (_svgEl) _svgEl.classList.remove('tree-highlight-active');
    const nodes = _nodesGroup?.querySelectorAll('.tree-node') || [];
    nodes.forEach(n => n.classList.remove('tree-highlighted-node'));
    const edges = _edgesGroup?.querySelectorAll('.tree-edge-group') || [];
    edges.forEach(g => g.classList.remove('tree-highlighted-edge'));
}

function setupInteractions(svg) {
    svg.addEventListener('mousedown', (e) => {
        if (e.target.closest('.tree-node') || e.target.closest('.tree-edge-hit')) return;
        if (state.linkingPerson) { cancelLinking(); }
        clearEdgeSelection();
    });
}

// --- Delete selected relationship ---

async function deleteSelectedRelationship() {
    if (!_edgesGroup) return;
    const sel = _edgesGroup.querySelector('.tree-edge-selected');
    if (!sel) return;

    const singleId = sel.getAttribute('data-rel-id');
    const multiIds = sel.getAttribute('data-rel-ids');

    const ids = [];
    if (singleId) {
        const parsed = parseInt(singleId, 10);
        if (!isNaN(parsed)) ids.push(parsed);
    }
    if (multiIds) {
        multiIds.split(',').forEach(s => {
            const parsed = parseInt(s, 10);
            if (!isNaN(parsed)) ids.push(parsed);
        });
    }

    if (ids.length === 0) return;

    for (const id of ids) {
        await window.api.invoke('remove-relationship', { id });
    }
    clearEdgeSelection();
    await refreshTree();
}

// --- Main entry / exit ---

function showTreeToolbar() {
    if (ui.treeModeWrap) ui.treeModeWrap.classList.remove('hidden');
    if (ui.timelineWrap) ui.timelineWrap.classList.add('hidden');
    if (ui.timelineWrap) ui.timelineWrap.style.display = 'none';
    hidePeopleToolbar();
    const groupByWrap = ui.groupBySelect?.closest('.groupBy-wrap');
    if (groupByWrap) groupByWrap.style.display = 'none';
    const filtersWrap = document.querySelector('.ui-filters');
    if (filtersWrap) filtersWrap.style.display = 'none';
}

function hideTreeToolbar() {
    if (ui.treeModeWrap) ui.treeModeWrap.classList.add('hidden');
    if (ui.timelineWrap) ui.timelineWrap.style.display = '';
    const groupByWrap = ui.groupBySelect?.closest('.groupBy-wrap');
    if (groupByWrap) groupByWrap.style.display = '';
    const filtersWrap = document.querySelector('.ui-filters');
    if (filtersWrap) filtersWrap.style.display = '';
}

function updateTreeStats(data) {
    if (!data) return;
    const total = (data.people || []).length;
    const relCount = (data.relationships || []).length;
    if (ui.treePeopleCount) ui.treePeopleCount.textContent = `${total} ${total === 1 ? 'Person' : 'People'}`;
    if (ui.treeRelCount) ui.treeRelCount.textContent = `${relCount} ${relCount === 1 ? 'Link' : 'Links'}`;
}

async function refreshTree() {
    const data = await window.api.invoke('get-family-tree');
    state.treeData = data;
    updateTreeStats(data);
    renderTree(data);
}

function renderTree(data) {
    if (!_svgEl || !_nodesGroup || !_edgesGroup) return;
    _nodesGroup.innerHTML = '';
    _edgesGroup.innerHTML = '';
    if (_bandContainer) _bandContainer.innerHTML = '';

    const { people, relationships } = data;

    if (people.length === 0) {
        _svgEl.removeAttribute('viewBox');
        renderEmptyTree();
        return;
    }

    const positions = forceLayout(people, relationships);
    _nodePositions = positions;

    const generations = assignGenerations(people, relationships);

    const nameOf = id => people.find(p => p.id === id)?.name || 'Unknown';
    const nonParentRels = relationships.filter(r => r.relationship_type !== 'parent-child');
    for (const rel of nonParentRels) {
        const posA = positions.get(rel.person_a_id);
        const posB = positions.get(rel.person_b_id);
        if (!posA || !posB) continue;
        const edgeEl = renderTreeEdge(rel, posA, posB, nameOf(rel.person_a_id), nameOf(rel.person_b_id));
        _edgesGroup.appendChild(edgeEl);
    }

    renderParentChildConnectors(relationships, positions, _edgesGroup, people);

    for (const person of people) {
        const pos = positions.get(person.id);
        if (!pos) continue;
        const nodeEl = renderTreeNode(person, pos.x, pos.y);
        _nodesGroup.appendChild(nodeEl);
    }

    const xs = Array.from(positions.values()).map(p => p.x);
    const ys = Array.from(positions.values()).map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const padX = 120;
    const padY = 100;
    const vbX = minX - padX;
    const vbY = minY - padY;
    const contentW = maxX - minX + padX * 2;
    const contentH = maxY - minY + padY * 2;

    _svgEl.removeAttribute('viewBox');
    _svgEl.setAttribute('width', String(contentW));
    _svgEl.setAttribute('height', String(contentH));
    _svgEl.style.minWidth = `${contentW}px`;
    _svgEl.style.minHeight = `${contentH}px`;

    _edgesGroup.setAttribute('transform', `translate(${-vbX}, ${-vbY})`);
    _nodesGroup.setAttribute('transform', `translate(${-vbX}, ${-vbY})`);

    renderGenerationBands(generations, positions, vbX, vbY, contentH);

    requestAnimationFrame(() => {
        if (_scrollArea) {
            const inner = _scrollArea.querySelector('.tree-inner');
            if (inner) {
                const areaH = _scrollArea.clientHeight;
                const areaW = _scrollArea.clientWidth;
                const toolbarClearance = 70;

                if (contentH < areaH - toolbarClearance) {
                    const topMargin = Math.max(toolbarClearance, (areaH - contentH) / 2);
                    inner.style.marginTop = `${topMargin}px`;
                    inner.style.marginBottom = '40px';
                } else {
                    inner.style.marginTop = `${toolbarClearance}px`;
                    inner.style.marginBottom = '40px';
                }

                if (contentW < areaW) {
                    inner.style.marginLeft = 'auto';
                    inner.style.marginRight = 'auto';
                } else {
                    inner.style.marginLeft = '0';
                    inner.style.marginRight = '0';
                }
            }
        }
        syncBandPositions();
    });
}

function renderEmptyTree() {
    const container = document.getElementById('familyTreeContainer');
    if (!container) return;

    container.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state-view';

    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.innerHTML = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="5" r="3" />
        <circle cx="6" cy="19" r="3" />
        <circle cx="18" cy="19" r="3" />
        <path d="M12 8l-4 8m8-8l4 8" />
    </svg>`;

    const title = document.createElement('h2');
    title.innerText = 'Family tree is empty';

    const text = document.createElement('p');
    text.innerText = state.indexingComplete.faces
        ? 'Identified people will appear here. Link them together to start building your family tree!'
        : 'Still analyzing your photos for faces. Once identies are found, you can return here to build your tree.';

    empty.appendChild(icon);
    empty.appendChild(title);
    empty.appendChild(text);
    container.appendChild(empty);
}

export async function openFamilyTree(switchGroupByFn) {
    _switchGroupByFn = switchGroupByFn;
    state.treeViewActive = true;
    state.inDetailsView = true;

    showTreeToolbar();
    initRelTypeDropdown();
    setMapVisibility(false, { skipRender: true });
    setGraphTransformEnabled(false);
    if (ui.floatingRecenterBtn) ui.floatingRecenterBtn.classList.add('hidden');

    ui.viewport.classList.remove('scrollable-mode');
    ui.viewport.style.cursor = 'default';
    ui.viewport.style.overflow = 'hidden';
    ui.connections.innerHTML = '';
    ui.gallery.innerHTML = '';
    ui.gallery.style.position = 'absolute';
    ui.gallery.style.inset = '0';
    ui.gallery.style.width = '100%';
    ui.gallery.style.height = '100%';
    ui.gallery.style.minHeight = '';
    ui.gallery.style.transform = 'none';

    const container = document.createElement('div');
    container.id = 'familyTreeContainer';
    container.className = 'family-tree-container';

    _bandContainer = document.createElement('div');
    _bandContainer.className = 'tree-band-layer';
    container.appendChild(_bandContainer);

    const scrollArea = document.createElement('div');
    scrollArea.className = 'tree-inner-scroll';
    _scrollArea = scrollArea;

    const inner = document.createElement('div');
    inner.className = 'tree-inner';

    _svgEl = createSVG(inner);
    setupInteractions(_svgEl);

    scrollArea.appendChild(inner);
    container.appendChild(scrollArea);

    scrollArea.addEventListener('scroll', () => {
        syncBandPositions();
    });

    const hintBar = document.createElement('div');
    hintBar.className = 'tree-hint-bar';
    const hint = document.createElement('span');
    hint.className = 'tree-hint';
    hint.textContent = 'Click a person to start linking \u00b7 Double-click to view photos \u00b7 Delete key to remove selected link';
    _hintEl = hint;
    hintBar.appendChild(hint);
    container.appendChild(hintBar);

    ui.gallery.appendChild(container);
    ui.viewport.scrollTop = 0;

    if (ui.treeResetBtn) {
        ui.treeResetBtn.onclick = async () => {
            const relCount = (state.treeData?.relationships || []).length;
            if (relCount === 0) return;
            if (!confirm(`This will remove all ${relCount} relationship link${relCount > 1 ? 's' : ''} from the family tree.\n\nThis cannot be undone. Continue?`)) return;
            try {
                await window.api.invoke('clear-all-relationships');
                await refreshTree();
            } catch (err) {
                console.error('Failed to reset tree:', err);
            }
        };
    }

    await refreshTree();
    updateNavActiveState();
}

export function closeFamilyTree() {
    if (!state.treeViewActive) return;
    state.treeViewActive = false;
    state.inDetailsView = false;
    state.linkingPerson = null;
    hideTreeToolbar();
    if (ui.treeResetBtn) ui.treeResetBtn.onclick = null;
    _svgEl = null;
    _nodesGroup = null;
    _edgesGroup = null;
    _bandContainer = null;
    _scrollArea = null;
    _bandData = [];
    _hintEl = null;
    if (ui.viewport) {
        ui.viewport.style.overflow = '';
    }
    if (ui.gallery) {
        ui.gallery.style.position = '';
        ui.gallery.style.inset = '';
        ui.gallery.style.width = '';
        ui.gallery.style.height = '';
        ui.gallery.style.transform = '';
    }
}

export function handleTreeKeydown(e) {
    if (!state.treeViewActive) return false;

    if (e.key === 'Escape') {
        if (state.linkingPerson) {
            cancelLinking();
            return true;
        }
        if (ui.relationshipModal && !ui.relationshipModal.classList.contains('hidden')) {
            ui.relationshipModal.classList.add('hidden');
            return true;
        }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (_edgesGroup && _edgesGroup.querySelector('.tree-edge-selected')) {
            deleteSelectedRelationship();
            return true;
        }
        if (e.key === 'Delete') return true;
        return false;
    }
    return false;
}
