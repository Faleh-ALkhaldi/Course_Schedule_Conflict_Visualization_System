// NEW-FU-525 (Batch 8 Issue 2): per-term resource INDEPENDENCE. The Add Venue /
// Add Instructor duplicate checks must be scoped strictly to the current term, so a
// room/email registered in one term never blocks adding the same name in another —
// the reported cross-term "phantom" block (01-0001 from term X rejected in empty
// term Y). Two terms may each own an independent venue with the same name.
const request = require('supertest');
const app = require('../../src/app');
const B = '/api/v1';
const A = (r, t) => r.set('Authorization', `Bearer ${t}`);

let tok;
beforeAll(async () => {
  tok = (await request(app).post(`${B}/auth/login`).send({ username: 'admin1', password: 'password123' })).body.token;
});

describe('Batch 8 — per-term resource independence (no cross-term phantom dup-block)', () => {
  test('the same venue name is addable in a different term, but not twice in one term', async () => {
    await A(request(app).post(`${B}/terms`), tok).send({ code: '331' });
    await A(request(app).post(`${B}/terms`), tok).send({ code: '332' });

    const a = await A(request(app).post(`${B}/venues`), tok).set('X-Active-Term', '331')
      .send({ name: '09-0009', type: 'LectureHall', capacity: 50 });
    expect(a.status).toBe(201);

    // Same name in a DIFFERENT (empty) term → independent venue, allowed.
    const b = await A(request(app).post(`${B}/venues`), tok).set('X-Active-Term', '332')
      .send({ name: '09-0009', type: 'LectureHall', capacity: 50 });
    expect(b.status).toBe(201);
    expect(b.body.id).not.toBe(a.body.id);

    // Same name AGAIN in the same term → still rejected.
    const c = await A(request(app).post(`${B}/venues`), tok).set('X-Active-Term', '331')
      .send({ name: '09-0009', type: 'LectureHall', capacity: 50 });
    expect(c.status).toBe(409);

    for (const x of ['331', '332']) {
      await A(request(app).delete(`${B}/terms/${x}`).query({ activeCode: '251' }), tok).catch(() => {});
    }
  });
});
