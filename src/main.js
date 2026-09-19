import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import {
  markEvidenceOverlayUnavailable,
  mountEvidenceHandoff,
  parseEvidenceHandoff,
} from './evidenceHandoff.js';
import { mountEvidenceHandoffOverlay } from './evidenceHandoffOverlay.js';

// The handoff is a bounded read-only snapshot carried in the URL. Mount its
// details before startup so source state remains visible if a provider fails;
// after startup, add only its session-local point and bounding-box feature.
const evidenceHandoff = parseEvidenceHandoff();
const evidenceCard = mountEvidenceHandoff({ decoded: evidenceHandoff });

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

let evidenceOverlay = null;
const startup = application.start();
startup
  .then(async ({ scene }) => {
    if (evidenceHandoff.status !== 'valid') return;
    try {
      const mounted = await mountEvidenceHandoffOverlay(
        scene.viewer,
        evidenceHandoff.envelope,
      );
      if (application.getState().status === 'ready') evidenceOverlay = mounted;
      else mounted.destroy();
    } catch (error) {
      console.error('Evidence handoff map feature failed:', error);
      markEvidenceOverlayUnavailable(evidenceCard);
    }
  })
  .catch(() => {
    // The authoritative startup error path below owns initialization failures.
  });

application.subscribe(({ status }) => {
  if (
    status === 'destroying' ||
    status === 'destroyed' ||
    status === 'failed'
  ) {
    evidenceOverlay?.destroy();
    evidenceOverlay = null;
  }
});

startup.catch((error) => {
  console.error('Eagle Eyes Global initialization failed:', error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = `Error: ${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

export { application };
