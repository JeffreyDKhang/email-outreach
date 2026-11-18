"""Generate the synthetic import fixture; standard library only."""
import csv
from pathlib import Path

companies = ['Amber Desk Studio', 'Birchline Accounting', 'Cedar Compass Design', 'Dovebridge Consulting', 'Elm Harbor Software', 'Fernpath Legal', 'Golden Kite Media', 'Hearthstone Analytics', 'Ivory Trail Recruiting', 'Juniper Finch Finance', 'Kindred Maple Studio', 'Lantern Bay Systems', 'Meadow Arc Architects', 'North Petal Insurance', 'Oak Ribbon Marketing', 'Pebble Peak Advisory', 'Quartz Nest Research', 'River Loom Engineering', 'Spruce Lantern Partners', 'Tandem Grove Digital', 'Umber Shore Services', 'Velvet Pine Creative', 'Willow Crest Labs', 'Yellow Finch Strategy', 'Acorn Harbor Group', 'Bluebell Ridge Design', 'Copper Grove Systems', 'Driftwood Finch Agency', 'Evergreen Loop Advisors', 'Fable Stone Studio', 'Garnet Lake Partners', 'Hazel Compass Media', 'Indigo Birch Research', 'Jade Meadow Consulting', 'Kestrel Elm Digital', 'Linden Cove Services', 'Marigold Trail Group', 'Nutmeg Harbor Analytics', 'Orchard Kite Studio', 'Pineglass Advisory']
first = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Jamie', 'Riley']
last = ['Chen', 'Patel', 'Martin', 'Singh', 'Lee']
roles = ['Office Manager', 'Workplace Manager', 'Operations Manager', 'People Manager', 'HR Manager', 'People Operations Manager']
facts = ['The office recently added a shared kitchen.', 'The team is moving into a larger office.', 'The office is adding ten onsite roles.', 'The team now has three shared office days each week.', 'The company recently opened this office.']
rows = []
for i, company in enumerate(companies):
    row = dict(lead_id=f'OP-{i+1:03}', first_name=first[i % 8], last_name=last[i // 8], email=f'lead{i+1:02}@example.com', company=company, job_title=roles[i % 6], city=['Toronto', 'Mississauga', 'Markham'][i % 3], industry=['Consulting', 'Design', 'Software', 'Accounting', 'Marketing'][i % 5], office_employees=[25, 40, 65, 90, 120, 150][i % 6], avg_daily_onsite=[18, 25, 40, 55, 75, 90][i % 6], purchasing_method=['manual shopping', 'ad hoc orders'][i % 2], company_fact=facts[i % 5], fact_source='Synthetic demo scenario', data_origin='synthetic')
    if 16 <= i < 22:
        row.update(office_employees=15, avg_daily_onsite=8, purchasing_method='existing supplier')
    if 22 <= i < 26:
        row.update(city=['Ottawa', 'Vancouver', 'Montreal', 'Calgary'][i-22])
    if 26 <= i < 29:
        row.update(avg_daily_onsite=2, purchasing_method='no pantry')
    if i == 29: row['job_title'] = 'Sales Representative'
    if i == 30: row['job_title'] = 'Software Developer'
    if i == 31: row['email'] = ''
    if i == 32: row['office_employees'] = ''
    if i == 33: row['avg_daily_onsite'] = ''
    if i == 34: row['city'] = ''
    if i in (35, 36): row.update(company_fact='', fact_source='')
    if i == 37: row.update(office_employees=300, avg_daily_onsite=180, purchasing_method='existing supplier')
    if i == 38: row.update(office_employees=8, avg_daily_onsite=4)
    if i == 39: row.update(office_employees=200, avg_daily_onsite=100)
    rows.append(row)

target = Path(__file__).resolve().parents[1] / 'data' / 'demo-leads.csv'
with target.open('w', newline='', encoding='utf-8') as stream:
    writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)

with target.open(newline='', encoding='utf-8') as stream:
    actual = list(csv.DictReader(stream))
assert len(actual) == 40
assert len({r['lead_id'] for r in actual}) == 40
assert len({r['email'] for r in actual if r['email']}) == 39
assert all(not r['email'] or r['email'].endswith('@example.com') for r in actual)
assert all(r['data_origin'] == 'synthetic' for r in actual)
assert all(not r['avg_daily_onsite'] or not r['office_employees'] or int(r['avg_daily_onsite']) <= int(r['office_employees']) for r in actual)
print(f'Validated {len(actual)} synthetic records: {target}')
