/**
 * The conversation the minimap study replays: eight turns of different shapes (long and short
 * answers, a table, code, a list, a quote) so the rail has something real to draw.
 */
export const MINIMAP_STUDY_TURNS: readonly {
  readonly prompt: string
  readonly thinking?: string
  readonly reply: string
}[] = [
  {
    prompt: 'Is a cold-climate heat pump worth it for a 1924 house in Portland?',
    thinking:
      'Portland winter design temperature is about 23°F. Most heating hours fall between 35°F and 45°F, where a cold-climate unit keeps a COP near 3.',
    reply: `Very likely, yes. Portland winters are mild for a heat pump: most heating hours fall between 35 and 45°F, where a modern cold-climate unit delivers about three units of heat for each unit of electricity.

## Where heat pumps disappoint

When a heat pump disappoints, the cause is usually the house rather than the climate:

- **Undersized equipment.** An installer sizes from square footage instead of a load calculation, and the unit runs flat out on the coldest nights.
- **Leaky ducts.** Ducts in an unconditioned attic or crawlspace can lose a fifth of the heat before it reaches a room.
- **Rooms that lose heat quickly.** Single-pane windows and uninsulated walls, both common in houses from the 1920s, push the load up.

A 1924 house can have all three, so sizing matters more than the brand.

## Keep the two decisions apart

Decide on the equipment separately from the fuel. Even if you keep a backup for the odd ice-storm week, the heat pump can carry nearly the whole season, and the backup only has to cover a few days a year.`,
  },
  {
    prompt: 'What size would we need?',
    reply: `Using typical values for a 1920s house of about 1,900 sq ft, a rough estimate lands between **30,000 and 40,000 BTU/h** at the design temperature. The front rooms carry an outsized share because of the single-pane glass.

Treat that range as a check on contractors' numbers, not a substitute for a Manual J calculation.`,
  },
  {
    prompt: 'Make me a 15-year cost comparison.',
    thinking:
      'Electricity at $0.14/kWh, heating oil at $4.10/gal, gas at $1.65/therm. Assume 2% annual price growth and no incentives.',
    reply: `Here's the comparison, assuming 2% yearly price growth and no incentives:

| Option | Up front | Yearly running cost | 15 years |
| --- | ---: | ---: | ---: |
| Cold-climate heat pump | $18,400 | $850 | $31,200 |
| New oil furnace | $9,800 | $2,330 | $44,900 |
| Gas furnace | $11,200 | $1,700 | $36,700 |
| Heat pump with gas backup | $21,900 | $910 | $35,600 |

The heat pump costs the most up front and the least to run. It passes gas around year 9 and oil around year 4.

Incentives change the picture quickly: the Energy Trust of Oregon and the federal credit together can take $3,000–$6,000 off the heat pump, which moves the break-even with gas to about year 5.`,
  },
  {
    prompt: 'Can you show me how you got the break-even years?',
    reply: `Sure. Each option's cumulative cost is the up-front price plus the running cost for every year so far, with prices growing 2% a year. The break-even year is the first year the heat pump's total drops below the other option's:

\`\`\`python
def cumulative(upfront, yearly, years, growth=0.02):
    total, cost = upfront, yearly
    for year in range(1, years + 1):
        total += cost
        cost *= 1 + growth
        yield year, total

def break_even(a, b, years=15):
    for (year, ta), (_, tb) in zip(cumulative(*a, years), cumulative(*b, years)):
        if ta <= tb:
            return year
    return None

heat_pump = (18_400, 850)
print(break_even(heat_pump, (9_800, 2_330)))   # oil → 4
print(break_even(heat_pump, (11_200, 1_700)))  # gas → 9
\`\`\`

Change the tuples to try your own quotes.`,
  },
  {
    prompt: 'Ducted or ductless?',
    reply: `If the existing ducts run through conditioned space and are in decent shape, a ducted system is the simpler install. Ductless heads make sense for the rooms the ducts serve poorly, like a finished attic.`,
  },
  {
    prompt: 'Draft an email asking two installers for quotes.',
    reply: `Here's a draft you can send to both:

> **Subject:** Quote request: heat pump to replace an oil furnace
>
> Hi,
>
> We're replacing the oil furnace in our 1924 house in Portland (about 1,900 sq ft, with existing ductwork). Could you quote a cold-climate heat pump? We'd like the quote to include:
>
> - a Manual J load calculation,
> - the model numbers of the outdoor and indoor units,
> - duct testing and any sealing you'd recommend, and
> - what you'd do with the old oil tank.
>
> We're free most weekday mornings for a site visit.
>
> Thanks,
> Sam

It asks for the things that make two quotes comparable, so you aren't comparing a sized system with a guess.`,
  },
  {
    prompt: 'What should we ask at the site visit?',
    thinking:
      'Focus on the questions that separate a careful installer from a fast one: sizing, placement, ducts, the oil tank, and paperwork.',
    reply: `These questions separate a careful installer from a fast one:

1. **Will you size it with a Manual J?** Ask to see the room-by-room numbers, not just the total.
2. **Where will the outdoor unit go?** It needs clearance for airflow and snow, and it shouldn't sit under a bedroom window.
3. **Will you test the ducts before quoting?** A leakage test takes under an hour and changes the right size.
4. **What happens to the oil tank?** Decommissioning is usually a separate job with its own permit.
5. **Who files the incentive paperwork?** Some rebates must be claimed by the contractor before installation.
6. **What's the defrost strategy?** On a 30°F wet morning, the unit will defrost every hour or so; ask how they keep that from blowing cold air.

Ask about the oil tank early, because it can add a week to the schedule.`,
  },
  {
    prompt: 'Thanks, this is really helpful.',
    reply: `Glad it helps. When the quotes come back, paste them here and I'll put them side by side against the Manual J numbers.`,
  },
]
