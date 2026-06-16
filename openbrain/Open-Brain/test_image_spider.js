import chalk from 'chalk';

const t = {
  primary: '#f97316',
  secondary: '#dc2626',
  accent: '#fbbf24',
  text: '#fed7aa',
  info: '#fb923c'
};

const G1 = chalk.hex(t.primary);       // orange
const G2 = chalk.hex(t.secondary);     // red
const G3 = chalk.hex(t.accent);        // yellow
const EY = chalk.bold.hex(t.accent);   // yellow eyes
const WB = chalk.hex('#555555');       // grey web
const SP = chalk.hex(t.info);          // orange sparkle
const W = chalk.bold.white;
const GY = chalk.gray;

const spiderArt = [
  /*  0 */  G1('       \\       /'),
  /*  1 */  G1('        \\  ') + WB('▼') + G1('  /'),
  /*  2 */  G1('  \\       \\ ') + WB('│') + G1(' /       /'),
  /*  3 */  G1('   \\       ') + W('▄█▄') + G1('       /'),
  /*  4 */  G1('\\   \\   ') + W('(') + EY(' ◉ ') + W('█') + EY(' ◉ ') + W(')') + G1('   /   /'),
  /*  5 */  G1(' \\   \\ ') + G3('█████████████') + G1(' /   /'),
  /*  6 */  G1('  \\──') + G3('███') + GY('▒▒▒▒▒▒▒') + G3('███') + G1('──/'),
  /*  7 */  G1('     / ') + G3('██') + GY('▒▒▒▒▒▒▒') + G3('██') + G1(' \\'),
  /*  8 */  G1('    / / ') + G3('██') + GY('▒▒▒▒▒') + G3('██') + G1(' \\ \\'),
  /*  9 */  G1('   / /   ') + G3('███████') + G1('   \\ \\'),
  /* 10 */  G1('  / /     ') + G2('█████') + G1('     \\ \\'),
  /* 11 */  G1('    /      ') + G2('███') + G1('      \\'),
  /* 12 */  '            ' + G2('█'),
  /* 13 */  '            ' + WB('│'),
  /* 14 */  '            ' + SP('✦')
];

// Padding to exactly 25 width
const paddedArt = spiderArt.map(row => {
  // Strip ANSI to get length
  const noAnsi = row.replace(/\u001b\[.*?m/g, '');
  const padLen = 27 - noAnsi.length;
  return row + ' '.repeat(Math.max(0, padLen));
});

for (const line of paddedArt) {
  console.log(line + '||');
}
