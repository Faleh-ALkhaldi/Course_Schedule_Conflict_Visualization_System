// NEW-FU-520 (Batch 6): strict per-term resource isolation. A resource created
// in one term must not leak into another, and an auto-resolver / manual write must
// never assign another term's private resource into this one (the reported
// `01-0001` contamination: a venue owned by 271 assigned to 261 sections).
//
// Locked here:
//   • A venue created while viewing term A (X-Active-Term: A) is owned by A.
//   • It appears in A's venue list but NOT in B's (blank-slate isolation).
//   • The write-layer guard rejects assigning A's venue to a section in B (409).

const request = require('supertest');
const app = require('../../src/app');
const B = '/api/v1';
const A = (r, t) => r.set('Authorization', `Bearer ${t}`);

let tok;
beforeAll(async () => {
  tok = (await request(app).post(`${B}/auth/login`).send({ username: 'admin1', password: 'password123' })).body.token;
});

async function freshTerm(code) {
  await A(request(app).post(`${B}/terms`), tok).send({ code });
  return (await A(request(app).get(`${B}/departments/SWE-DEPT/schedules`), tok)).body.find(s => s.semester === code);
}

describe('Batch 6 — per-term resource isolation', () => {
  test('a term-owned venue is invisible to other terms and cannot be assigned across terms', async () => {
    await freshTerm('311');
    const s312 = await freshTerm('312');

    // Create a venue while VIEWING term 311 → owner_semester = 311.
    const mk = await A(request(app).post(`${B}/venues`), tok)
      .set('X-Active-Term', '311')
      .send({ name: '99-9999', type: 'LectureHall', capacity: 60 });
    expect(mk.status).toBe(201);
    const v311 = mk.body.id;

    // Visible in 311's list, NOT in 312's (blank-slate isolation).
    const list312 = (await A(request(app).get(`${B}/venues?term=312`), tok)).body.map(v => v.name);
    const list311 = (await A(request(app).get(`${B}/venues?term=311`), tok)).body.map(v => v.name);
    expect(list311).toContain('99-9999');
    expect(list312).not.toContain('99-9999');

    // Write-layer guard: assigning 311's venue to a 312 section is rejected.
    const courses = (await A(request(app).get(`${B}/courses`), tok)).body;
    const instr   = (await A(request(app).get(`${B}/instructors`), tok)).body;
    const jun = courses.find(c => c.academic_level === 'Junior' && c.credits === 3);
    const cs = await A(request(app).post(`${B}/schedules/${s312.id}/sections`), tok).send({
      courseId: jun.id, instructorId: instr[0].id, venueId: v311,
      sectionNumber: '01', sectionType: 'Lec',
      days: ['Sunday', 'Tuesday', 'Thursday'], startTime: '10:00', endTime: '10:50',
    });
    expect(cs.status).toBe(409);
    expect(cs.body.error).toMatch(/belongs to term 311/i);

    for (const c of ['311', '312']) {
      await A(request(app).delete(`${B}/terms/${c}`).query({ activeCode: '251' }), tok).catch(() => {});
    }
  });
});
