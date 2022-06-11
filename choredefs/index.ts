import * as Render from '../deps/render.ts'
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
