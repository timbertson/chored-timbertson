import { run } from '../deps/cmd.ts'

export async function build(_: {}) {
	await run(['rm', '-rf', 'dist'])
	await run(['./setup.py', 'sdist'])
}

export async function release(_: {}) {
	const distFiles = []
	for await(const f of Deno.readDir('dist')) {
		distFiles.push('dist/'+ f.name)
	}
	await run(['twine', 'check'].concat(distFiles))
	await run(['twine', 'upload'].concat(distFiles))
}

