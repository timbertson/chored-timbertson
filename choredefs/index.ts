import * as Render from 'https://raw.githubusercontent.com/timbertson/chored/4adfc96a523295642e0b5b0404eadc776b59202f/lib/render.ts#main'
import chores from '../lib/scala.ts'

async function render(opts: {}) {
  Render.render([], {
    localDeps: {
      sources: {
        chored: '../chored'
      }
    }
  })
}
const example = chores({ repo: 'scala-example' })

export default {
	... example,
	render: {
		default: render,
		example: example.render
	}
}
