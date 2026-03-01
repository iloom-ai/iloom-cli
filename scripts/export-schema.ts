import { writeFile, mkdir, readFile } from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { IloomSettingsSchema } from '../src/lib/SettingsManager.js'
import { PackageIloomSchema } from '../src/utils/package-json.js'

async function exportSchema() {
	const jsonSchema = zodToJsonSchema(IloomSettingsSchema, {
		name: 'IloomSettings',
		$refStrategy: 'none', // Inline all references for simplicity
	})

	const outputDir = path.join(process.cwd(), 'dist', 'schema')
	const outputPath = path.join(outputDir, 'settings.schema.json')

	await mkdir(outputDir, { recursive: true })
	await writeFile(outputPath, JSON.stringify(jsonSchema, null, 2), 'utf-8')

	console.log(`✓ Settings schema exported to ${outputPath}`)

	// Export package.iloom schema
	const packageIloomJsonSchema = zodToJsonSchema(PackageIloomSchema, {
		name: 'PackageIloom',
		$refStrategy: 'none',
	})

	const packageIloomOutputPath = path.join(outputDir, 'package-iloom.schema.json')
	await writeFile(packageIloomOutputPath, JSON.stringify(packageIloomJsonSchema, null, 2), 'utf-8')

	console.log(`✓ Package iloom schema exported to ${packageIloomOutputPath}`)

	// Embed schemas into init template
	// The tsup build copies templates to dist/prompts/ before this script runs
	const initTemplatePath = path.join(process.cwd(), 'dist', 'prompts', 'init-prompt.txt')

	if (existsSync(initTemplatePath)) {
		let template = await readFile(initTemplatePath, 'utf-8')

		// Replace the raw block containing SETTINGS_SCHEMA with the schema JSON
		// The raw block syntax {{{{raw}}}}...{{{{/raw}}}} is used in the source template
		// to prevent Handlebars from parsing the curly braces during development.
		// At build time, we replace the entire raw block with the actual schema JSON.
		// Single braces in JSON are safe since Handlebars only parses {{ double braces }}.
		const settingsSchemaJson = JSON.stringify(jsonSchema, null, 2)
		template = template.replace(
			'{{{{raw}}}}{{SETTINGS_SCHEMA}}{{{{/raw}}}}',
			settingsSchemaJson
		)

		// Replace the raw block containing PACKAGE_ILOOM_SCHEMA with the package iloom schema JSON
		const packageIloomSchemaJson = JSON.stringify(packageIloomJsonSchema, null, 2)
		template = template.replace(
			'{{{{raw}}}}{{PACKAGE_ILOOM_SCHEMA}}{{{{/raw}}}}',
			packageIloomSchemaJson
		)

		await writeFile(initTemplatePath, template, 'utf-8')
		console.log(`✓ Schemas embedded in init template at ${initTemplatePath}`)
	} else {
		console.warn(`⚠ Init template not found at ${initTemplatePath} - skipping schema embedding`)
	}
}

exportSchema().catch(console.error)
