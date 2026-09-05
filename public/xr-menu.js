/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import * as THREE from 'three';
import { fitText, roundedRect } from './hud.js';

const CANVAS_WIDTH = 1024;
const CANVAS_HEIGHT = 1200;
const PANEL_WIDTH_METERS = 0.95;
const PANEL_HEIGHT_METERS = 1.1;
const PANEL_DISTANCE_METERS = 1.25;
const MAX_VISIBLE_ROWS = 9;

export class XRMenuRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = CANVAS_HEIGHT;
    this.context = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_WIDTH_METERS, PANEL_HEIGHT_METERS),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.mesh.position.set(0, 0, -PANEL_DISTANCE_METERS);
    this.mesh.renderOrder = Number.MAX_SAFE_INTEGER;
    this.mesh.visible = false;
  }

  update(camera, { visible, title = 'Settings', items = [], selectedIndex = 0 } = {}) {
    if (!camera) return;
    if (this.mesh.parent !== camera) {
      this.mesh.parent?.remove(this.mesh);
      camera.add(this.mesh);
    }

    this.mesh.visible = Boolean(visible);
    if (!visible || !this.context) return;

    this.draw(title, items, selectedIndex);
    this.texture.needsUpdate = true;
  }

  draw(title, items, selectedIndex) {
    const context = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const margin = 48;
    const headerHeight = 132;
    const rowGap = 10;
    const rowHeight = 88;
    const visibleCount = Math.min(MAX_VISIBLE_ROWS, items.length);
    const maxStartIndex = Math.max(0, items.length - visibleCount);
    const startIndex = Math.min(
      maxStartIndex,
      Math.max(0, selectedIndex - Math.floor(visibleCount / 2)),
    );
    const visibleItems = items.slice(startIndex, startIndex + visibleCount);

    context.clearRect(0, 0, width, height);
    roundedRect(context, 8, 8, width - 16, height - 16, 24);
    context.fillStyle = 'rgba(8, 12, 17, 0.94)';
    context.fill();
    context.lineWidth = 5;
    context.strokeStyle = '#4caf50';
    context.stroke();

    context.fillStyle = '#f4f7fb';
    context.font = 'bold 58px monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(title, width / 2, margin + 34);

    visibleItems.forEach((item, visibleIndex) => {
      const itemIndex = startIndex + visibleIndex;
      const y = headerHeight + margin + visibleIndex * (rowHeight + rowGap);
      const selected = itemIndex === selectedIndex;
      roundedRect(context, margin, y, width - margin * 2, rowHeight, 8);
      context.fillStyle = selected ? 'rgba(76, 175, 80, 0.34)' : 'rgba(255, 255, 255, 0.055)';
      context.fill();
      if (selected) {
        context.lineWidth = 4;
        context.strokeStyle = '#87e18a';
        context.stroke();
      }

      context.globalAlpha = item.disabled ? 0.42 : 1;
      context.textBaseline = 'middle';
      context.font = 'bold 38px monospace';
      context.textAlign = 'left';
      context.fillStyle = item.id === 'exitXR' ? '#ff8f8f' : '#f4f7fb';
      context.fillText(fitText(context, item.label, width * 0.46), margin + 24, y + rowHeight / 2);

      if (item.value) {
        context.font = 'bold 34px monospace';
        context.textAlign = 'right';
        context.fillStyle = '#a7d8ff';
        const value = item.adjustable ? `< ${item.value} >` : item.value;
        context.fillText(fitText(context, value, width * 0.44), width - margin - 24, y + rowHeight / 2);
      }
      context.globalAlpha = 1;
    });

    context.fillStyle = '#9fb0c2';
    context.font = 'bold 28px monospace';
    context.textAlign = 'center';
    const footerY = height - 32;
    const scrollPosition = `${selectedIndex + 1} / ${items.length}`;
    const previousIndicator = startIndex > 0 ? '^  ' : '';
    const nextIndicator = startIndex + visibleCount < items.length ? '  v' : '';
    context.fillText(`${previousIndicator}${scrollPosition}${nextIndicator}`, width / 2, footerY);
  }

  hide() {
    this.mesh.visible = false;
  }
}
