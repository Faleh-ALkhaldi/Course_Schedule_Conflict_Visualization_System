const Section = require('../../src/domain/Section');
const R06Rule = require('../../src/engine/rules/R06Rule');

const section = (overrides = {}) => new Section({
  id: 's1',
  scheduleId: 'sch1',
  courseId: 'c1',
  courseCode: 'SWE 305',
  category: 'UG',
  academicLevel: 'Junior',
  sectionNumber: '01',
  day: 'Sunday',
  startTime: '22:10',
  endTime: '23:00',
  sectionType: 'Lec',
  ...overrides,
});

describe('R06Rule conflict-exempt activities', () => {
  test('direct R06 calls skip the same exempt family the engine skips', () => {
    expect(R06Rule.evaluate(section({ isCapstone: true }))).toEqual([]);
    expect(R06Rule.evaluate(section({ isThesis: true }))).toEqual([]);
    expect(R06Rule.evaluate(section({ isResearch: true }))).toEqual([]);
    expect(R06Rule.evaluate(section({ isExternal: true }))).toEqual([]);

    expect(R06Rule.evaluate(section({ sectionType: 'Prj' }))).toEqual([]);
    expect(R06Rule.evaluate(section({ sectionType: 'Ths' }))).toEqual([]);
    expect(R06Rule.evaluate(section({ sectionType: 'Res' }))).toEqual([]);
    expect(R06Rule.evaluate(section({ sectionType: 'St' }))).toEqual([]);
    expect(R06Rule.evaluate(section({ sectionType: 'Int' }))).toEqual([]);

    expect(R06Rule.evaluate(section())).toHaveLength(1);
  });
});
