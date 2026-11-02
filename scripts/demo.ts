import { createFixture } from './fixture.js';

const fixture = await createFixture();
process.env.LOOK_IN_GIT_DISCOVERY_ROOT = fixture.base;
process.env.LOOK_IN_GIT_REPO = fixture.root;
console.log(`Temporary Look-in-Git fixture: ${fixture.base}`);
console.log('This demo only discovers its temporary fixture. It does not inspect existing repositories.');
await import('../server/index.js');
