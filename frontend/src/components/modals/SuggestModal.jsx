import React, { useState } from 'react';
import { useApp, LEVEL_COLORS } from '../../context/AppContext.jsx';
import './SectionModal.css';
import './SuggestModal.css';

const LEVEL_ORDER  = ['Freshman','Sophomore','Junior','Senior','Graduate'];
const DAY_PATTERNS = [
  { value:'STT', label:'Sun / Tue / Thu', note:'50 min/class' },
  { value:'MW',  label:'Mon / Wed',       note:'75 min/class' },
];

export default function SuggestModal({ onConfirm, onClose }) {
  const { courses } = useApp();

  // courseConfig: { [courseId]: { sections: number, pattern: 'STT'|'MW' } }
  const [config, setConfig] = useState(() => {
    const init = {};
    for (const c of courses) {
      init[c.id] = { sections: 1, pattern: c.category === 'GR' ? 'STT' : 'STT' };
    }
    return init;
  });

  function setField(courseId, field, value) {
    setConfig(prev => ({ ...prev, [courseId]: { ...prev[courseId], [field]: value } }));
  }

  function handleSubmit() {
    // Build the request payload
    const payload = courses.map(c => ({
      courseId:  c.id,
      courseCode: c.course_code,
      sections:  parseInt(config[c.id]?.sections ?? 1),
      pattern:   config[c.id]?.pattern ?? 'STT',
    }));
    onConfirm(payload);
  }

  const grouped = LEVEL_ORDER.map(level => ({
    level,
    courses: courses.filter(c => c.academic_level === level),
  })).filter(g => g.courses.length > 0);

  return (
    <div className="sm-overlay" onClick={e => e.target===e.currentTarget && onClose()}>
      <div className="sm-card suggest-card">
        <div className="sm-header">
          <h2 className="sm-title">✦ Auto-Suggest Schedule</h2>
          <button className="sm-close" onClick={onClose}>×</button>
        </div>

        <p className="suggest-desc">
          Configure how many sections each course needs and which day pattern to use.
          The system will find the best time slots to minimize conflicts.
        </p>

        <div className="suggest-table-wrap">
          <table className="suggest-table">
            <thead>
              <tr>
                <th>Course</th>
                <th>Level</th>
                <th style={{textAlign:'center'}}># Sections</th>
                <th>Day Pattern</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(({ level, courses: cs }) => (
                <React.Fragment key={level}>
                  <tr className="suggest-level-row">
                    <td colSpan={4} style={{
                      background: LEVEL_COLORS[level]?.bg,
                      color: LEVEL_COLORS[level]?.border,
                      fontWeight: 700, fontSize: '.72rem',
                      textTransform: 'uppercase', letterSpacing: '.06em',
                      padding: '4px 12px',
                    }}>
                      {level}
                    </td>
                  </tr>
                  {cs.map(course => {
                    const cfg   = config[course.id] ?? { sections:1, pattern:'STT' };
                    const isGR  = course.category === 'GR';
                    return (
                      <tr key={course.id} className="suggest-course-row">
                        <td>
                          <span className="suggest-code">{course.course_code}</span>
                          <span className="suggest-name">{course.name}</span>
                        </td>
                        <td>
                          <span className="suggest-cat"
                            style={{color: LEVEL_COLORS[level]?.border}}>
                            {course.category}
                          </span>
                        </td>
                        <td style={{textAlign:'center'}}>
                          <input
                            type="number" min="1" max="10"
                            value={cfg.sections}
                            onChange={e => setField(course.id, 'sections', e.target.value)}
                            className="suggest-num-input"
                          />
                        </td>
                        <td>
                          <div className="suggest-pattern-group">
                            {DAY_PATTERNS.map(p => (
                              <label key={p.value} className={`suggest-pattern-btn ${cfg.pattern===p.value?'active':''}`}>
                                <input type="radio" name={`pat-${course.id}`}
                                  value={p.value} checked={cfg.pattern===p.value}
                                  onChange={() => setField(course.id, 'pattern', p.value)} />
                                <span>{p.label}</span>
                                <small>{p.note}</small>
                              </label>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <div className="sm-actions" style={{padding:'0 24px 20px'}}>
          <button className="sm-btn-cancel" onClick={onClose}>Cancel</button>
          <button className="sm-btn-save" onClick={handleSubmit}
            disabled={courses.length === 0}>
            ✦ Run Suggest →
          </button>
        </div>
      </div>
    </div>
  );
}
