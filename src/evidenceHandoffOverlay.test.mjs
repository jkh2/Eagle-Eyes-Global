import assert from 'node:assert/strict';
import test from 'node:test';
import { mountEvidenceHandoffOverlay } from './evidenceHandoffOverlay.js';

function envelope(overrides = {}) {
  return {
    source_record_id: '2026-CAYNP-000100',
    retrieved_at: '2026-09-19T16:38:55.775Z',
    state: 'LIVE',
    geometry: {
      lat: 37.5992068751971,
      lon: -119.60739222710066,
      bbox: [-119.7, 37.5, -119.5, 37.7],
    },
    ...overrides,
  };
}

function fakeViewer() {
  const added = [];
  const removed = [];
  return {
    added,
    removed,
    dataSources: {
      async add(source) {
        added.push(source);
        return source;
      },
      remove(source, destroy) {
        removed.push({ source, destroy });
        return true;
      },
    },
  };
}

test('adds exactly one packet point and one explicitly named bounding box', async () => {
  const viewer = fakeViewer();
  const mounted = await mountEvidenceHandoffOverlay(
    viewer,
    envelope(),
    Date.parse('2026-09-19T17:08:55.775Z'),
  );
  assert.equal(viewer.added.length, 1);
  const entities = mounted.dataSource.entities.values;
  assert.equal(entities.length, 2);
  const point = entities.find((entity) => entity.id.endsWith(':point'));
  const box = entities.find((entity) => entity.id.endsWith(':bbox'));
  assert.match(point.label.text.getValue(), /2026-CAYNP-000100/);
  assert.match(point.label.text.getValue(), /LIVE · retrieved 30 min ago/);
  assert.match(point.label.text.getValue(), /BOUNDING BOX SHOWN/);
  assert.match(point.label.text.getValue(), /UNSIGNED SNAPSHOT/);
  assert.equal(box.name, '2026-CAYNP-000100 bounding box');
  assert.equal(
    box.properties.geometryMeaning.getValue(),
    'bounding box, not perimeter',
  );
});

test('never invents a bounding box when the packet did not supply one', async () => {
  const viewer = fakeViewer();
  const mounted = await mountEvidenceHandoffOverlay(
    viewer,
    envelope({ geometry: { lat: 37.5, lon: -119.6 } }),
  );
  assert.equal(mounted.dataSource.entities.values.length, 1);
  assert.match(
    mounted.dataSource.entities.values[0].label.text.getValue(),
    /NO BOUNDING BOX SUPPLIED/,
  );
});

test('destroy removes and destroys only its session-local data source', async () => {
  const viewer = fakeViewer();
  const mounted = await mountEvidenceHandoffOverlay(viewer, envelope());
  mounted.destroy();
  mounted.destroy();
  assert.deepEqual(viewer.removed, [
    { source: mounted.dataSource, destroy: true },
  ]);
});
