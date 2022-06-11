import * as Render from 'https://raw.githubusercontent.com/timbertson/chored/dbddf21a43be2d134a4f5d491004f3282b1a07a7/lib/render.ts#main'
import chores from '../lib/scala.ts'

async function render(_: {}) {
  await Render.render([])
}
const example = chores({ repo: 'scala-example' })

export default {
	... example,
	render: {
		default: render,
		example: example.render
	}
}
