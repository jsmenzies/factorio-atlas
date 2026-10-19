/**
 * Community nicknames for game names, so "red science" finds automation science packs.
 * Keys are prototype names (items, fluids, entities); values are lowercase phrases people
 * type. Display names ("automation science pack") are indexed separately and need no entry.
 *
 * Ambiguous slang is left out on purpose: "reds" could be red science, red circuits or red
 * belts, so only the full phrases are listed. Shared by indexing (server) and search hints.
 */
export const NICKNAMES: Record<string, string[]> = {
	// Science packs, by colour, plus their pre-0.17 names.
	'automation-science-pack': ['red science', 'red sci', 'red pack', 'science pack 1'],
	'logistic-science-pack': ['green science', 'green sci', 'green pack', 'science pack 2'],
	'military-science-pack': ['black science', 'grey science', 'gray science', 'mil science'],
	'chemical-science-pack': ['blue science', 'blue sci', 'blue pack', 'science pack 3'],
	'production-science-pack': ['purple science', 'purple sci', 'prod science'],
	'utility-science-pack': ['yellow science', 'yellow sci', 'high tech science'],
	'space-science-pack': ['white science', 'white sci'],
	'metallurgic-science-pack': ['orange science', 'vulcanus science'],
	'electromagnetic-science-pack': ['pink science', 'magenta science', 'fulgora science', 'em science'],
	'agricultural-science-pack': ['gleba science', 'agri science', 'ag science'],
	'cryogenic-science-pack': ['aquilo science', 'cryo science'],
	'promethium-science-pack': ['promethium science', 'shattered planet science'],

	// Circuits.
	'electronic-circuit': ['green circuit', 'green circuits', 'greens', 'gc'],
	'advanced-circuit': ['red circuit', 'red circuits', 'rc'],
	'processing-unit': ['blue circuit', 'blue circuits', 'bc', 'blue chips'],
	'quantum-processor': ['quantum chip', 'quantum chips'],

	// Belts by colour (turbo is green).
	'transport-belt': ['yellow belt', 'yellow belts', 'basic belt'],
	'fast-transport-belt': ['red belt', 'red belts'],
	'express-transport-belt': ['blue belt', 'blue belts'],
	'turbo-transport-belt': ['green belt', 'green belts', 'turbo belt', 'turbo belts'],
	'underground-belt': ['yellow underground', 'ug'],
	'fast-underground-belt': ['red underground'],
	'express-underground-belt': ['blue underground'],
	'turbo-underground-belt': ['green underground'],
	splitter: ['yellow splitter'],
	'fast-splitter': ['red splitter'],
	'express-splitter': ['blue splitter'],
	'turbo-splitter': ['green splitter'],

	// Inserters by colour, and old names.
	'burner-inserter': ['burner inserter'],
	inserter: ['yellow inserter', 'yellow inserters'],
	'long-handed-inserter': ['red inserter', 'red inserters', 'long inserter', 'long inserters'],
	'fast-inserter': ['blue inserter', 'blue inserters', 'filter inserter'],
	'bulk-inserter': ['green inserter', 'green inserters', 'stack filter inserter'],
	'stack-inserter': ['belt stacking', 'stacking inserter'],

	// Intermediates.
	'iron-gear-wheel': ['gear', 'gears'],
	'copper-cable': ['copper wire', 'cable', 'cables'],
	'iron-stick': ['iron rod', 'iron rods', 'stick', 'sticks'],
	'low-density-structure': ['lds', 'low density'],
	'rocket-control-unit': ['rcu'],
	'flying-robot-frame': ['robot frame', 'robot frames', 'frf'],
	'electric-engine-unit': ['electric engine', 'electric engines'],
	'engine-unit': ['engine', 'engines'],
	'plastic-bar': ['plastic'],
	'steel-plate': ['steel'],
	'stone-brick': ['bricks', 'brick'],
	'solid-fuel': ['solid fuel'],
	'rocket-fuel': ['rocket fuel'],
	'rocket-part': ['rocket', 'rocket parts'],
	'uranium-235': ['u235', 'u-235'],
	'uranium-238': ['u238', 'u-238'],
	'uranium-fuel-cell': ['fuel cell', 'fuel cells'],
	'nuclear-fuel': ['nuclear fuel'],

	// Fluids.
	'petroleum-gas': ['petgas', 'pet gas', 'petroleum', 'pgas'],
	lubricant: ['lube'],
	'sulfuric-acid': ['acid', 'sulphuric acid'],
	'crude-oil': ['crude', 'oil'],

	// Modules.
	'speed-module': ['speed 1', 'speed1', 'speed module 1'],
	'speed-module-2': ['speed 2', 'speed2'],
	'speed-module-3': ['speed 3', 'speed3'],
	'productivity-module': ['prod 1', 'prod1', 'prod module 1'],
	'productivity-module-2': ['prod 2', 'prod2'],
	'productivity-module-3': ['prod 3', 'prod3', 'prod mod', 'prod modules'],
	'efficiency-module': ['eff 1', 'eff1', 'efficiency 1'],
	'efficiency-module-2': ['eff 2', 'eff2'],
	'efficiency-module-3': ['eff 3', 'eff3'],
	'quality-module-3': ['quality 3', 'qual 3'],

	// Machines.
	'assembling-machine-1': ['am1', 'assembler 1', 'gray assembler'],
	'assembling-machine-2': ['am2', 'assembler 2', 'blue assembler'],
	'assembling-machine-3': ['am3', 'assembler 3', 'green assembler'],
	'electric-mining-drill': ['miner', 'miners', 'drill', 'drills', 'emd'],
	'big-mining-drill': ['big drill', 'big miner', 'bmd'],
	'oil-refinery': ['refinery', 'refineries'],
	'chemical-plant': ['chem plant', 'chem plants'],
	'electromagnetic-plant': ['em plant', 'em plants', 'emp'],
	'cryogenic-plant': ['cryo plant', 'cryo plants'],
	'electric-furnace': ['e furnace', 'electric furnaces'],
	'stone-furnace': ['stone furnaces'],
	'steel-furnace': ['steel furnaces'],
	'rocket-silo': ['silo', 'rocket silo'],
	'nuclear-reactor': ['reactor', 'nuclear', 'reactors'],
	'steam-turbine': ['turbine', 'turbines'],
	'steam-engine': ['steam engine', 'steam engines'],
	'solar-panel': ['solar', 'solar field'],
	accumulator: ['accu', 'accus', 'accumulators'],
	'heat-exchanger': ['heat exchanger', 'hx'],
	'space-platform-hub': ['platform', 'space platform'],
	'train-stop': ['station', 'stations', 'train station'],
	locomotive: ['train', 'trains', 'loco'],
	roboport: ['roboport', 'bots', 'robots'],
	'gun-turret': ['turret', 'turrets'],
	'laser-turret': ['laser', 'lasers'],
	'stone-wall': ['wall', 'walls']
};

/** Every nickname for a name, lowercase. */
export const nicknamesFor = (name: string): string[] => NICKNAMES[name] ?? [];
