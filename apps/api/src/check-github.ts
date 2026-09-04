import { scanRepository } from './github.js'

const repo = process.argv[2] ?? 'https://github.com/octocat/Hello-World'
console.log(JSON.stringify(await scanRepository(repo), null, 2))
