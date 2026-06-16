import chalk from 'chalk';
const G2 = chalk.hex('#dc2626');

// Compact 12-line Braille spider — matches info box height
const spiderArt = [
  G2('    ⢠⡏ ⢀⣾          ⢷⡀ ⢹⣄    '),
  G2('   ⢸⣿  ⣸⣿⡇          ⢸⣿⣇  ⣿⡇   '),
  G2('   ⣿⣿  ⣿⣿⣧⣤⣤⣤⣤⣤⣤⣼⣿⣿  ⣿⣿   '),
  G2('  ⢸⣿⡏ ⠙⢉⣉⣩⣴⣶⣤⣙⣿⣶⣯⣦⣴⣼⣷⣿⣋⣤⣶⣦⣍⣉⡉⠋ ⢸⣿⡇  '),
  G2('  ⢿⣿⣷⣤⣶⣶⠿⠿⠛⠋⣉⡉⠙⢛⣿⣿⣿⣿⣿⣿⣿⣿⡛⠛⢉⣉⠙⠛⠿⠿⣶⣶⣤⣾⣿⡿  '),
  G2('   ⠙⠻⠋⠉  ⣠⣾⡿⠟⠛⣻⣿⣿⣿⣿⣿⣿⣿⣿⣟⠛⠻⢿⣷⣄  ⠉⠙⠟⠋   '),
  G2('⢀ ⣀⣴⣾⠟⠋   ⢸⣿⣿  ⢸⣿⣿⣿⣿⣿⣿⡇  ⣿⣿⡇   ⠙⠻⣷⣦⣀ ⣀'),
  G2('⢸⣿⣿⠋⠁     ⢸⣿⣿  ⠈⣿⣿⣿⣿⣿⣿⠁  ⣿⣿⡇     ⠈⠙⣿⣿⡟'),
  G2('⢸⣿⣷       ⢸⣿⣿   ⢿⣿⣿⡿   ⣿⣿⡇       ⣾⣿⡇'),
  G2(' ⣿⣿       ⢸⣿⣿   ⠈⠿⠿⠁   ⣿⣿⡇       ⣿⣿ '),
  G2(' ⠘⣿⡇       ⣿⣿         ⣿⣿       ⢸⣿⠃ '),
  G2('  ⠸⣷       ⢹⣿         ⣿⡟       ⣾⠏  '),
];

for (const line of spiderArt) {
  console.log(line + '||');
}
console.log(`Lines: ${spiderArt.length}`);
