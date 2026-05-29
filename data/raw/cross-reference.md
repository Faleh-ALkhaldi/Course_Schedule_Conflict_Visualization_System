# SWE Catalog × Term Offerings — cross-reference report

Generated: 2026-05-28 from `data/raw/catalog-swe-ug.json` and `offerings-{251,252,253,261}.json`.

## Active UG courses (insert these — 18)

A catalog course is "active" if it appears in at least one of {251, 252, 253, 261}.

```
SWE206  Introduction to Software Engineering          (lec+lab)
SWE216  Software Requirements Engineering             (lec only)
SWE316  Software Design and Construction              (lec only)
SWE326  Software Testing                              (lec only)
SWE363  Web Engineering & Development                 (lec only)
SWE387  Software Project Management                   (lec only)
SWE399  Summer Training                               (ST — no schedule)
SWE402  Game Programming                              (lec only)
SWE412  Software Engineering Project II               (PRJ — usually no schedule)
SWE413  Senior Design Project I                       (PRJ)
SWE414  Senior Project II                             (PRJ)
SWE422  Usability Engineering                         (lec only)
SWE439  Software Quality Engineering                  (lec only)
SWE445  Secure Software Development                   (lec only)
SWE455  Cloud Applications Engineering                (lec only)
SWE463  Mobile Application Development                (lec only)
SWE494  Undergraduate Thesis I                        (THS — no schedule)
SWE496  Undergraduate Thesis II                       (THS — no schedule)
```

## Obsolete catalog courses (DROP — 25)

In the official UG catalog but not offered in 251/252/253/261. Per user directive, exclude entirely.

```
SWE205, SWE214, SWE215, SWE302, SWE311, SWE312, SWE321, SWE322,
SWE344, SWE411, SWE415, SWE416, SWE417, SWE418, SWE421, SWE423,
SWE436, SWE440, SWE444, SWE446, SWE469, SWE487, SWE490, SWE491,
SWE497
```

## Grad-only / out-of-scope (SKIP — 9)

Codes seen in offerings but not in the UG catalog (5xx and 6xx). Out of UG scope.

```
SWE503, SWE516, SWE539, SWE545, SWE555, SWE587, SWE595, SWE599, SWE610
```

## Per-term row counts (UG only after filter)

| Term | UG-course rows | Total raw rows | UG courses present |
|------|---------------:|---------------:|:------|
| 251  | 13 courses     | 43             | 206, 216, 316, 326, 363, 387, 412, 413, 422, 439, 463, 494, 496 |
| 252  | 16 courses     | 50             | 206, 216, 316, 326, 363, 387, 402, 412, 413, 414, 422, 439, 445, 455, 494, 496 |
| 253  | 1 course       | 1              | 399 |
| 261  | 12 courses     | 45             | 206, 216, 316, 326, 363, 387, 402, 413, 414, 422, 439, 463 |

## Activity-type distribution (UG rows only)

| Activity | Count | Notes |
|----------|------:|-------|
| LEC      | 90 | Standard lecture, scheduled |
| LAB      | 17 | Standard lab, scheduled |
| PRJ      | 17 | Project — sometimes has time, sometimes blank (SWE 412/413/414) |
| THS      | 5  | Thesis — never has time (SWE 494/496) |
| ST       | 1  | Summer Training — never has time (SWE 399) |

**130 of 139 UG rows are schedulable** (have day + time). 9 rows have blank day/time and will be **skipped** during DB insert (existing schema requires `day`, `start_time`, `end_time` NOT NULL).

## Female section numbers observed

Distinct `F##` suffixes across all terms: F02, F03, F04, F05, F11, F12, F13, F55, F56, F57, F61, F62, F63.

After F-stripping into the gender column, the numeric section_number ranges become:
- Female Lec: 02–13
- Female Lab: 55–63
- Male Lec:   01–05
- Male Lab:   51–54

No numeric collisions between male and female sections of any course, so gender + section_number + day + course is unique.

## Venues seen (44 unique rooms)

```
22-119, 22-125, 22-127, 22-130, 22-132, 22-134, 22-231, 22-333, 22-334, 22-335, 22-339
24-128, 24-137, 24-141, 24-146, 24-151, 24-153, 24-156, 24-165, 24-174, 24-178, 24-180, 24-236A, 24-240, 24-240-1, 24-244, 24-249
42-AUD
59-1003, 59-1007, 59-1009, 59-1010, 59-1013, 59-1016, 59-1017, 59-2004, 59-2017
63-128
7-220
76-1126, 76-1127, 76-1128, 76-2156
78-3018
```

Plus the sentinel `412-None` (placeholder used for unassigned rooms) and blank locations — both inserted as NULL.

## Instructors seen (28 unique faculty)

```
ALAAULDEEN SABR, AULIA FADLI, HAMOUD ALJAMAAN, HASAN AL-KAF, KHADIJAH ALSAFWAN,
KHALID ALJASSER, LYDIA ABRAHAM FIREW, MAHMOOD NIAZI, MAJED ALZAYER, MALAK BASLYMAN,
MANSOUR ALHARTHI, MD MAHFUZUR RAHMAN, MOHAMMAD AMRO, MOHD SHAMEEM SALEEM,
MUHAMMAD FAISAL ABDULRAZZAK, NUHA ABDULRAHMAN ALBADI, OMAR HAMMAD, OMAR MAHMOUD,
OVAIS KHAN, QURRAT UL AIN NAHEED, SAAD EZZINI, SAJJAD MAHMOOD, SULAFAH NORULDEEN,
WALEED ALGOBI, WASFI AL-KHATIB, YAHYA OSAIS, YASMIN YASIN, YUSUF HASSAN
```

Term 261 has zero instructor assignments yet (instructor field blank for every row) — fall 2025–26 scheduling is staffed later.
