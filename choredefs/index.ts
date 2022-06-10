import * as Render from 'https://raw.githubusercontent.com/timbertson/chored/9a51bbeedab0b30f9a434518f768aa50a6c42ae5/lib/render.ts#main'
import chores from '../lib/scala.ts'

async function render(opts: {}) {
  Render.render([])
}
const example = chores({ repo: 'scala-example' })

export default {
	... example,
	render: {
		default: render,
		example: example.render
	}
}
