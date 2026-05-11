/**
 * Seeds the database with realistic test data matching the SRS examples.
 * Run: node src/db/seed.js
 * Idempotent — safe to run multiple times (uses INSERT … ON CONFLICT DO NOTHING).
 */
require('dotenv').config();
const { pool } = require('../config/db');
const bcrypt = require('bcryptjs');

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Users ──────────────────────────────────────────────────────────────
    const pwHash = await bcrypt.hash('password123', 10);
    await client.query(`
      INSERT INTO users (id, username, email, password_hash, role) VALUES
        ('00000000-0000-0000-0000-000000000001', 'scheduler1', 'scheduler@dept.edu', $1, 'scheduler'),
        ('00000000-0000-0000-0000-000000000002', 'admin1',     'admin@dept.edu',     $1, 'admin')
      ON CONFLICT (username) DO NOTHING
    `, [pwHash]);

    // ── Instructors ────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO instructors (id, name, email) VALUES
        ('10000000-0000-0000-0000-000000000001', 'Dr. Hassan',  'hassan@dept.edu'),
        ('10000000-0000-0000-0000-000000000002', 'Dr. Ali',     'ali@dept.edu'),
        ('10000000-0000-0000-0000-000000000003', 'Dr. Noor',    'noor@dept.edu'),
        ('10000000-0000-0000-0000-000000000004', 'Dr. Khalid',  'khalid@dept.edu'),
        ('10000000-0000-0000-0000-000000000005', 'Dr. Rashed',  'rashed@dept.edu'),
        ('10000000-0000-0000-0000-000000000006', 'Dr. Salem',   'salem@dept.edu'),
        ('10000000-0000-0000-0000-000000000007', 'Dr. Mona',    'mona@dept.edu'),
        ('10000000-0000-0000-0000-000000000008', 'Dr. Yusuf',   'yusuf@dept.edu'),
        ('10000000-0000-0000-0000-000000000009', 'Dr. Ibrahim', 'ibrahim@dept.edu')
      ON CONFLICT (email) DO NOTHING
    `);

    // ── Office Hours ───────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO office_hours (instructor_id, day, start_time, end_time) VALUES
        ('10000000-0000-0000-0000-000000000001', 'Monday',    '11:00', '12:00'),
        ('10000000-0000-0000-0000-000000000002', 'Tuesday',   '10:00', '11:00'),
        ('10000000-0000-0000-0000-000000000003', 'Wednesday', '13:00', '14:00'),
        ('10000000-0000-0000-0000-000000000004', 'Thursday',  '09:00', '10:00'),
        ('10000000-0000-0000-0000-000000000005', 'Sunday',    '12:00', '13:00')
    `);

    // ── Venues ─────────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO venues (id, name, type, capacity) VALUES
        ('20000000-0000-0000-0000-000000000001', 'H-101', 'LectureHall', 120),
        ('20000000-0000-0000-0000-000000000002', 'H-201', 'LectureHall', 100),
        ('20000000-0000-0000-0000-000000000003', 'H-301', 'LectureHall',  80),
        ('20000000-0000-0000-0000-000000000004', 'G-101', 'Laboratory',   40),
        ('20000000-0000-0000-0000-000000000005', 'G-102', 'Laboratory',   40)
      ON CONFLICT (name) DO NOTHING
    `);

    // ── Courses ────────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO courses (id, course_code, name, credits, academic_level, category, num_sections) VALUES
        ('30000000-0000-0000-0000-000000000001', 'SWE101', 'Intro to Software Engineering',    3, 'Freshman',  'UG', 3),
        ('30000000-0000-0000-0000-000000000002', 'SWE201', 'Software Design Principles',       3, 'Sophomore', 'UG', 2),
        ('30000000-0000-0000-0000-000000000003', 'SWE301', 'Software Architecture',            3, 'Junior',    'UG', 1),
        ('30000000-0000-0000-0000-000000000004', 'SWE321', 'Requirements Engineering',         3, 'Junior',    'UG', 1),
        ('30000000-0000-0000-0000-000000000005', 'SWE310', 'Software Quality Assurance',       3, 'Junior',    'UG', 1),
        ('30000000-0000-0000-0000-000000000006', 'SWE411', 'Software Engineering Projects',    3, 'Senior',    'UG', 1),
        ('30000000-0000-0000-0000-000000000007', 'SWE422', 'Software Project Management',      3, 'Senior',    'UG', 2),
        ('30000000-0000-0000-0000-000000000008', 'SWE501', 'Advanced Software Architecture',   3, 'Graduate',  'GR', 1),
        ('30000000-0000-0000-0000-000000000009', 'SWE510', 'Machine Learning Engineering',     3, 'Graduate',  'GR', 1)
      ON CONFLICT (course_code) DO NOTHING
    `);

    // ── Schedule ───────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO schedules (id, department_id, semester, status, created_by) VALUES
        ('40000000-0000-0000-0000-000000000001', 'SWE-DEPT', 'Fall-2025', 'Draft',
         '00000000-0000-0000-0000-000000000001')
      ON CONFLICT (department_id, semester) DO NOTHING
    `);

    // ── Sections (conflict-free baseline) ─────────────────────────────────
    const schedId  = '40000000-0000-0000-0000-000000000001';
    await client.query(`
      INSERT INTO sections
        (id, schedule_id, course_id, instructor_id, venue_id, section_number, day, start_time, end_time)
      VALUES
        -- SWE101 Freshman × 3 sections
        ('50000000-0000-0000-0000-000000000001', $1,
         '30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
         '20000000-0000-0000-0000-000000000001','A','Sunday',   '08:00','09:30'),
        ('50000000-0000-0000-0000-000000000002', $1,
         '30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002',
         '20000000-0000-0000-0000-000000000002','B','Monday',   '08:00','09:30'),
        ('50000000-0000-0000-0000-000000000003', $1,
         '30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
         '20000000-0000-0000-0000-000000000003','C','Tuesday',  '08:00','09:30'),
        -- SWE201 Sophomore × 2
        ('50000000-0000-0000-0000-000000000004', $1,
         '30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000003',
         '20000000-0000-0000-0000-000000000001','A','Sunday',   '10:00','11:30'),
        ('50000000-0000-0000-0000-000000000005', $1,
         '30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000003',
         '20000000-0000-0000-0000-000000000002','B','Tuesday',  '10:00','11:30'),
        -- SWE321 Junior single-section
        ('50000000-0000-0000-0000-000000000006', $1,
         '30000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000004',
         '20000000-0000-0000-0000-000000000003','A','Monday',   '12:00','13:30'),
        -- SWE411 Senior single-section
        ('50000000-0000-0000-0000-000000000007', $1,
         '30000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000005',
         '20000000-0000-0000-0000-000000000001','A','Wednesday','12:00','13:30'),
        -- SWE501 Graduate (after 17:00)
        ('50000000-0000-0000-0000-000000000008', $1,
         '30000000-0000-0000-0000-000000000008','10000000-0000-0000-0000-000000000007',
         '20000000-0000-0000-0000-000000000004','A','Sunday',   '18:00','19:30'),
        -- SWE510 Graduate (after 17:00)
        ('50000000-0000-0000-0000-000000000009', $1,
         '30000000-0000-0000-0000-000000000009','10000000-0000-0000-0000-000000000008',
         '20000000-0000-0000-0000-000000000005','A','Tuesday',  '18:00','19:30')
      ON CONFLICT (schedule_id, course_id, section_number) DO NOTHING
    `, [schedId]);

    await client.query('COMMIT');
    console.log('✓ Seed data applied successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
