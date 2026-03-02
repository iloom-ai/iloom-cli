import { copyFile, cp } from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'

async function copyDocs() {
	const distDir = path.join(process.cwd(), 'dist')
	const readmeSrc = path.join(process.cwd(), 'README.md')
	const readmeDest = path.join(distDir, 'README.md')

	// Copy README.md to dist
	if (existsSync(readmeSrc)) {
		await copyFile(readmeSrc, readmeDest)
		console.log(`✓ README.md copied to ${readmeDest}`)
	} else {
		console.warn(`⚠ README.md not found at ${readmeSrc} - skipping copy`)
	}

	// Copy openclaw-skill/ to dist
	const openclawSrc = path.join(process.cwd(), 'openclaw-skill')
	const openclawDest = path.join(distDir, 'openclaw-skill')
	if (existsSync(openclawSrc)) {
		await cp(openclawSrc, openclawDest, { recursive: true })
		console.log(`✓ openclaw-skill/ copied to ${openclawDest}`)
	} else {
		console.warn(`⚠ openclaw-skill/ not found at ${openclawSrc} - skipping copy`)
	}
}

copyDocs().catch(console.error)