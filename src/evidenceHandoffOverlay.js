import * as Cesium from 'cesium';
import { formatRetrievedAge } from './evidenceHandoff.js';

const OVERLAY_COLOR = Cesium.Color.fromCssColorString('#ffb347');

function pointLabel(envelope, nowMs) {
  const bounds = Array.isArray(envelope.geometry.bbox)
    ? 'BOUNDING BOX SHOWN'
    : 'NO BOUNDING BOX SUPPLIED';
  return [
    envelope.source_record_id,
    `${envelope.state} · ${formatRetrievedAge(envelope.retrieved_at, nowMs)}`,
    bounds,
    'UNSIGNED SNAPSHOT',
  ].join('\n');
}

/**
 * Add one session-local map feature from the supplied packet only.
 * No fetch, refresh, persistent layer, or nearby-record substitution occurs.
 */
export async function mountEvidenceHandoffOverlay(
  viewer,
  envelope,
  nowMs = Date.now(),
) {
  if (!viewer?.dataSources?.add || !viewer?.dataSources?.remove) {
    throw new TypeError('Evidence handoff overlay requires a Cesium viewer');
  }
  const dataSource = new Cesium.CustomDataSource(
    `evidence-handoff:${envelope.source_record_id}`,
  );
  dataSource.entities.add({
    id: `evidence-handoff:${envelope.source_record_id}:point`,
    name: `${envelope.source_record_id} evidence snapshot`,
    position: Cesium.Cartesian3.fromDegrees(
      envelope.geometry.lon,
      envelope.geometry.lat,
      0,
    ),
    point: {
      pixelSize: 13,
      color: OVERLAY_COLOR,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: pointLabel(envelope, nowMs),
      font: '12px monospace',
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 4,
      showBackground: true,
      backgroundColor: Cesium.Color.BLACK.withAlpha(0.76),
      pixelOffset: new Cesium.Cartesian2(18, -18),
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    properties: {
      evidenceHandoff: true,
      sourceRecordId: envelope.source_record_id,
      packetState: envelope.state,
      retrievedAt: envelope.retrieved_at,
      unsigned: true,
    },
  });

  if (Array.isArray(envelope.geometry.bbox)) {
    const [west, south, east, north] = envelope.geometry.bbox;
    dataSource.entities.add({
      id: `evidence-handoff:${envelope.source_record_id}:bbox`,
      name: `${envelope.source_record_id} bounding box`,
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(west, south, east, north),
        material: OVERLAY_COLOR.withAlpha(0.1),
        outline: true,
        outlineColor: OVERLAY_COLOR,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        classificationType: Cesium.ClassificationType.BOTH,
      },
      properties: {
        evidenceHandoff: true,
        geometryMeaning: 'bounding box, not perimeter',
        sourceRecordId: envelope.source_record_id,
        unsigned: true,
      },
    });
  }

  await viewer.dataSources.add(dataSource);
  viewer.scene?.requestRender?.();
  let destroyed = false;
  return Object.freeze({
    dataSource,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      viewer.dataSources.remove(dataSource, true);
    },
  });
}
