/**
 * Contract doubles for SAIP's own test tiers and for embedders testing against SAIP (#198).
 * Nothing in here is used by production code paths.
 */
export { startFakeS3, FAKE_ACCESS_KEY, FAKE_SECRET_KEY, PAGE_SIZE, verifySigV4 } from './fake-s3.js'
export type { FakeS3, FakeRequest } from './fake-s3.js'
